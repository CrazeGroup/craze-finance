import prisma from '@/lib/prisma';
import salespeopleMapData from '@/lib/salespeopleMap.json';
import { ledgerKey, customerDocType, vendorDocType } from '@/lib/documentTypes';

// Helper to get OAuth token via Entra ID for Business Central
export async function getAccessToken(tenantId: string, clientId: string, clientSecret: string) {
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.businesscentral.dynamics.com/.default');

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    body: params,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to obtain access token: ${errorText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Helper to update records in parallel chunks
async function chunkedUpdate(updates: any[], updateFn: (update: any) => Promise<any>, chunkSize = 50) {
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    await Promise.all(chunk.map(updateFn));
  }
}

// Compara un movimiento de cliente guardado con el que llega de BC
// (incluye la fecha de pago confirmada, que puede informarse en BC después de crear la factura)
function invoiceChanged(existing: any, data: any) {
  return (
    existing.amount !== data.amount ||
    existing.originalAmount !== data.originalAmount ||
    existing.status !== data.status ||
    existing.paymentMethod !== data.paymentMethod ||
    existing.type !== data.type ||
    existing.customerId !== data.customerId ||
    existing.dueDate.getTime() !== data.dueDate.getTime() ||
    (existing.confirmedPaymentDate?.getTime() || 0) !== (data.confirmedPaymentDate?.getTime() || 0)
  );
}

// Fecha de pago confirmada de un movimiento de cliente. El nombre del campo en la API custom de BC
// puede llevar sufijo (p. ej. ...CRZ), así que se busca cualquier campo con "confirm" en el nombre.
function findConfirmedPaymentDate(entry: any): Date | null {
  const isDate = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !v.startsWith('0001-01-01');
  const explicit = [entry.confirmedPaymentDate, entry.crazeConfirmedPaymentDate, entry.craze_ConfirmedPaymentDate].find(isDate);
  if (explicit) return new Date(explicit);
  const key = Object.keys(entry).find(k => k.toLowerCase().includes('confirm') && isDate(entry[k]));
  if (key) return new Date(entry[key]);
  return isDate(entry.promisedPayDate) ? new Date(entry.promisedPayDate) : null;
}

// Helper to fetch all pages of OData V4 response
async function fetchODataAllPages(startUrl: string, accessToken: string): Promise<any[]> {
  let nextUrl: string | null = startUrl;
  const allResults: any[] = [];
  let pageCount = 0;
  const MAX_PAGES = 100; // Increased to 100 to prevent truncating large accounts like Rossman
  
  while (nextUrl && pageCount < MAX_PAGES) {
    pageCount++;
    console.log(`Fetching page ${pageCount}: ${nextUrl}`);
    
    // Add an AbortController to prevent Vercel 504 timeouts if BC is too slow (fallback queries can hang)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout per page

    try {
      const response: any = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OData request failed: ${errorText}`);
      }
      const jsonData: any = await response.json();
      if (jsonData.value && Array.isArray(jsonData.value)) {
        allResults.push(...jsonData.value);
      }
      
      const newNextUrl = jsonData['@odata.nextLink'] || null;
      if (newNextUrl === nextUrl) {
        console.warn('Infinite loop detected in OData nextLink. Breaking.');
        break;
      }
      nextUrl = newNextUrl;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error(`Business Central API tardó demasiado en responder (más de 8 segundos). Si es una empresa sin la API personalizada, instala la extensión.`);
      }
      throw fetchError;
    }
  }
  return allResults;
}

export async function syncBusinessCentral(specificCompany?: string, step: 'customers' | 'invoices' | 'vendors' | 'vendorInvoices' | 'recurring' | 'all' = 'all') {
  const config = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
  if (!config || !config.tenantId || !config.clientId || !config.clientSecret) {
    throw new Error('La configuración de Business Central está incompleta. Por favor, rellena todos los campos en Ajustes.');
  }

  const accessToken = await getAccessToken(config.tenantId, config.clientId, config.clientSecret);
  const baseUrl = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}/api/v2.0`;
  const odataBaseUrl = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}/ODataV4`;

  // Fetch all companies from BC to get their IDs
  const companiesUrl = `${baseUrl}/companies`;
  const compRes = await fetch(companiesUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });
  if (!compRes.ok) throw new Error(`Failed to fetch companies: ${await compRes.text()}`);
  const compData = await compRes.json();

  const targetCompanyNames = specificCompany ? [specificCompany] : [
    'CRAZE', 
    'Craze Iberia SL', 
    'Craze Toys', 
    'CRAZE Group AG', 
    'Craze Entertainment'
  ];

  let totalStats = {
    customers: 0,
    invoices: 0,
    vendors: 0,
    purchaseInvoices: 0,
    // Nombres de campo que devuelve BC en los movimientos de cliente (sin valores), para diagnóstico
    custLedgerFields: [] as string[]
  };

  const salespeopleMap = new Map<string, string>(
    Object.entries(salespeopleMapData)
  );

  for (const companyName of targetCompanyNames) {
    console.log(`\n--- Sincronizando empresa: ${companyName} ---`);
    
    // Attempt to match company name exactly as returned by BC
    const matchedCompany = compData.value.find((c: any) => c.name.toLowerCase() === companyName.toLowerCase());
    if (!matchedCompany) {
      console.warn(`Empresa "${companyName}" no encontrada en este entorno de BC. Saltando...`);
      continue;
    }

    const companyId = matchedCompany.id;
    const exactCompanyName = matchedCompany.name; // Keep exact casing from BC
    const escapedCompanyName = exactCompanyName.replace(/'/g, "''");
    const companySegment = `/companies(${companyId})`;

    // Ensure CashflowConfig exists for this company
    await prisma.cashflowConfig.upsert({
      where: { companyId_currencyCode: { companyId: exactCompanyName, currencyCode: 'EUR' } },
      update: {},
      create: { companyId: exactCompanyName, currencyCode: 'EUR' }
    });

    try {
      // 1. Fetch Payment Methods mapping
      const paymentMethodsUrl = `${baseUrl}${companySegment}/paymentMethods`;
      const pmRes = await fetch(paymentMethodsUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Accept': 'application/json' }
      });
      let pmMap: Record<string, string> = {};
      if (pmRes.ok) {
        const pmData = await pmRes.json();
        for (const pm of pmData.value) {
          pmMap[pm.id] = pm.code;
        }
      } else {
        console.warn(`[${exactCompanyName}] Failed to fetch payment methods: ${await pmRes.text()}`);
      }

      // Use Custom API instead of standard API to get salesperson details
      const customApiBaseUrl = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}/api/craze/integrations/v1.0/companies(${companyId})`;

      // 2. Fetch Customers
      if (step === 'all' || step === 'customers') {
        console.log(`[${exactCompanyName}] Sincronizando Customers...`);
        const customersUrl = `${customApiBaseUrl}/customers`;
      
      const allCustomersData = await fetchODataAllPages(customersUrl, accessToken);
      
      if (allCustomersData.length > 0) {
        console.log('Sample custom customer:', JSON.stringify(allCustomersData[0]));
      }

      const allDbCustomers = await prisma.customer.findMany({
        where: { companyId: exactCompanyName },
        select: { id: true, bcId: true, name: true, email: true, paymentMethod: true, riskLimit: true, balance: true, salespersonCode: true, salespersonName: true }
      });
      const dbCustomerMap = new Map(allDbCustomers.map(c => [c.bcId, c]));

      const custCreates: any[] = [];
      const custUpdates: any[] = [];

      for (const c of allCustomersData) {
        // Handle both standard and custom API field names
        const customerNumber = c.number || c.no;
        if (!customerNumber) continue;

        const pmCode = c.paymentMethodId && pmMap[c.paymentMethodId] ? pmMap[c.paymentMethodId] : 'Standard';

        const custData = {
          name: c.displayName || c.name || c.number,
          email: c.email || null,
          paymentMethod: pmCode,
          riskLimit: c.creditLimitLCY !== undefined ? c.creditLimitLCY : (c.creditLimit || 0),
          balance: c.balance || c.balanceLCY || 0,
          salespersonCode: c.salespersonCode || c.salesPersonCode || null,
          salespersonName: c.salespersonName || c.salesPersonName || (c.salespersonCode ? salespeopleMap.get(c.salespersonCode) : null) || (c.salesPersonCode ? salespeopleMap.get(c.salesPersonCode) : null) || c.salespersonCode || c.salesPersonCode || null,
          companyId: exactCompanyName
        };

        const existingCust = dbCustomerMap.get(customerNumber);
        if (existingCust) {
          if (
            existingCust.name !== custData.name ||
            existingCust.email !== custData.email ||
            existingCust.paymentMethod !== custData.paymentMethod ||
            existingCust.riskLimit !== custData.riskLimit ||
            existingCust.balance !== custData.balance ||
            existingCust.salespersonCode !== custData.salespersonCode ||
            existingCust.salespersonName !== custData.salespersonName
          ) {
            custUpdates.push({
              where: { id: existingCust.id },
              data: custData
            });
          }
        } else {
          custCreates.push({
            bcId: customerNumber,
            ...custData
          });
        }
        totalStats.customers++;
      }

      if (custCreates.length > 0) {
        await prisma.customer.createMany({
          data: custCreates,
          skipDuplicates: true
        });
      }
      if (custUpdates.length > 0) {
        await chunkedUpdate(custUpdates, (u) => prisma.customer.update(u));
      }
      } // End of customers step

      // 3. Fetch Customer Ledger Entries (Invoices/Recobros)
      if (step === 'all' || step === 'invoices') {
      console.log(`[${exactCompanyName}] Sincronizando Customer Ledger Entries...`);
      try {
        // Todos los movimientos abiertos, de cualquier Document Type (facturas, abonos, pagos, ...)
        const ledgerUrl = `${customApiBaseUrl}/custLedgerEntries?$filter=open eq true`;
        
        const allLedgerData = await fetchODataAllPages(ledgerUrl, accessToken);
        if (allLedgerData.length > 0) totalStats.custLedgerFields = Object.keys(allLedgerData[0]);
        const syncedCustomerInvoiceIds: string[] = [];
        
        // --- BULK OPTIMIZATION START ---
        // Fetch all customers for this company at once
        const allCustomers = await prisma.customer.findMany({ where: { companyId: exactCompanyName } });
        const customerMap = new Map(allCustomers.map(c => [c.bcId, c]));
        
        // Fetch all existing invoices for this company at once
        const allInvoices = await prisma.invoice.findMany({ 
          where: { companyId: exactCompanyName },
          select: { id: true, bcId: true, customerId: true, type: true, amount: true, originalAmount: true, status: true, dueDate: true, paymentMethod: true, confirmedPaymentDate: true }
        });
        const invoiceMap = new Map(allInvoices.map(i => [i.bcId, i]));
        
        const invoiceCreates: any[] = [];
        const invoiceUpdates: any[] = [];
        const activeDocumentIds = new Set<string>();
        const pendingInvoices = new Map<string, any>();

        for (const entry of allLedgerData) {
          const customerBcId = entry.customerNo || entry.customerNumber || entry.sellToCustomerNo || entry.Customer_No;
          if (!customerBcId) continue;
          
          const customer = customerMap.get(String(customerBcId));
          if (!customer) continue;

          const remainingAmount = entry.remainingAmount !== undefined ? entry.remainingAmount : 0;
          const originalAmount = entry.amount !== undefined ? entry.amount : 0;
          const dueDate = entry.dueDate ? new Date(entry.dueDate) : new Date();
          const paymentMethodToSave = entry.paymentMethodCode ? entry.paymentMethodCode : customer.paymentMethod;
          
          const confirmedPaymentDate = findConfirmedPaymentDate(entry);

          const documentBcId = entry.documentNo || entry.documentNumber || entry.Document_No;
          if (!documentBcId) continue;

          const invData = {
            customerId: customer.id,
            type: customerDocType(entry.documentType),
            status: dueDate < new Date() ? 'Overdue' : 'Open',
            amount: remainingAmount,
            originalAmount: originalAmount,
            currencyCode: entry.currencyCode || 'EUR',
            paymentMethod: paymentMethodToSave,
            dueDate,
            confirmedPaymentDate,
            companyId: exactCompanyName
          };

          // Varios movimientos con la misma clave (p. ej. un pago repartido) se suman
          const key = ledgerKey(entry.documentType, String(documentBcId), entry.entryNo);
          const pending = pendingInvoices.get(key);
          if (pending) {
            pending.amount += invData.amount;
            pending.originalAmount += invData.originalAmount;
          } else {
            pendingInvoices.set(key, invData);
          }
          totalStats.invoices++;
        }

        for (const [key, invData] of pendingInvoices) {
          activeDocumentIds.add(key);
          const existingInvoice = invoiceMap.get(key);
          if (existingInvoice) {
            // Only update if something changed
            if (invoiceChanged(existingInvoice, invData)) {
              invoiceUpdates.push({
                where: { id: existingInvoice.id },
                data: invData
              });
            }
          } else {
            invoiceCreates.push({
              bcId: key,
              ...invData
            });
          }
        }
        
        // Execute creates in bulk
        if (invoiceCreates.length > 0) {
          await prisma.invoice.createMany({
            data: invoiceCreates,
            skipDuplicates: true
          });
        }
        
        // Execute updates in chunks
        if (invoiceUpdates.length > 0) {
          await chunkedUpdate(invoiceUpdates, (u) => prisma.invoice.update(u));
        }

        // Close invoices that are no longer active
        if (activeDocumentIds.size > 0) {
          await prisma.invoice.updateMany({
            where: { 
              companyId: exactCompanyName,
              bcId: { notIn: Array.from(activeDocumentIds) } 
            },
            data: { status: 'Closed' }
          });
        }
        // --- BULK OPTIMIZATION END ---
      } catch (error) {
        console.warn(`[${exactCompanyName}] Custom API failed, falling back to ODataV4:`, error);
        
        const fallbackLedgerUrl = `${odataBaseUrl}/Company('${escapedCompanyName}')/Cust_LedgerEntries?$filter=Open eq true`;
        try {
          const allFallbackData = await fetchODataAllPages(fallbackLedgerUrl, accessToken);
          // --- BULK OPTIMIZATION START (Fallback) ---
          const fallbackAllCustomers = await prisma.customer.findMany({ where: { companyId: exactCompanyName } });
          const fallbackCustomerMap = new Map(fallbackAllCustomers.map(c => [c.bcId, c]));
          
          const fallbackAllInvoices = await prisma.invoice.findMany({ 
            where: { companyId: exactCompanyName },
            select: { id: true, bcId: true, customerId: true, type: true, amount: true, originalAmount: true, status: true, dueDate: true, paymentMethod: true, confirmedPaymentDate: true }
          });
          const fallbackInvoiceMap = new Map(fallbackAllInvoices.map(i => [i.bcId, i]));
          
          const fallbackCreates: any[] = [];
          const fallbackUpdates: any[] = [];
          const fallbackActiveIds = new Set<string>();
          const fallbackPending = new Map<string, any>();

          for (const entry of allFallbackData) {
            const customerBcId = entry.Customer_No || entry.customerNo || entry.customerNumber || entry.sellToCustomerNo;
            if (!customerBcId) continue;

            const customer = fallbackCustomerMap.get(String(customerBcId));
            if (!customer) continue;

            const remainingAmount = entry.Remaining_Amount !== undefined ? entry.Remaining_Amount : 0;
            const originalAmount = entry.Amount !== undefined ? entry.Amount : 0;
            const dueDate = entry.Due_Date ? new Date(entry.Due_Date) : new Date();
            
            const confirmedDateStr = entry.Promised_Pay_Date;
            const confirmedPaymentDate = (confirmedDateStr && !confirmedDateStr.startsWith('0001-01-01')) ? new Date(confirmedDateStr) : null;

            const documentBcId = entry.Document_No || entry.documentNo || entry.documentNumber;
            if (!documentBcId) continue;

            const fallbackInvData = {
              amount: remainingAmount,
              originalAmount: originalAmount,
              dueDate: dueDate,
              status: dueDate < new Date() ? 'Overdue' : 'Open',
              paymentMethod: customer.paymentMethod,
              confirmedPaymentDate: confirmedPaymentDate,
              customerId: customer.id,
              type: customerDocType(entry.Document_Type),
              companyId: exactCompanyName
            };

            const key = ledgerKey(entry.Document_Type, String(documentBcId), entry.Entry_No);
            const pending = fallbackPending.get(key);
            if (pending) {
              pending.amount += fallbackInvData.amount;
              pending.originalAmount += fallbackInvData.originalAmount;
            } else {
              fallbackPending.set(key, fallbackInvData);
            }
            totalStats.invoices++;
          }

          for (const [key, fallbackInvData] of fallbackPending) {
            fallbackActiveIds.add(key);
            const existingFallback = fallbackInvoiceMap.get(key);
            if (existingFallback) {
              if (invoiceChanged(existingFallback, fallbackInvData)) {
                fallbackUpdates.push({
                  where: { id: existingFallback.id },
                  data: fallbackInvData
                });
              }
            } else {
              fallbackCreates.push({
                bcId: key,
                ...fallbackInvData
              });
            }
          }
          
          if (fallbackCreates.length > 0) {
            await prisma.invoice.createMany({
              data: fallbackCreates,
              skipDuplicates: true
            });
          }
          if (fallbackUpdates.length > 0) {
            await chunkedUpdate(fallbackUpdates, (u) => prisma.invoice.update(u));
          }

          if (fallbackActiveIds.size > 0) {
            await prisma.invoice.updateMany({
              where: { 
                companyId: exactCompanyName,
                bcId: { notIn: Array.from(fallbackActiveIds) } 
              },
              data: { status: 'Closed' }
            });
          }
          // --- BULK OPTIMIZATION END (Fallback) ---
        } catch (error: any) {
          console.error(`[${exactCompanyName}] Fallback Cust_LedgerEntries also failed:`, error.message);
        }
      }
      } // End of invoices step

      // 4. Fetch Vendors
      if (step === 'all' || step === 'vendors') {
      console.log(`[${exactCompanyName}] Sincronizando Vendors...`);
      const vendorsUrl = `${baseUrl}${companySegment}/vendors`;
      const allVendorsData = await fetchODataAllPages(vendorsUrl, accessToken);
      
      const allDbVendors = await prisma.vendor.findMany({
        where: { companyId: exactCompanyName },
        select: { id: true, bcId: true, name: true, email: true, paymentMethod: true, balance: true }
      });
      const dbVendorMap = new Map(allDbVendors.map(v => [v.bcId, v]));

      const venCreates: any[] = [];
      const venUpdates: any[] = [];

      for (const v of allVendorsData) {
        const pmCode = v.paymentMethodId && pmMap[v.paymentMethodId] ? pmMap[v.paymentMethodId] : 'Standard';

        const venData = {
          name: v.displayName || v.number,
          email: v.email || null,
          paymentMethod: pmCode,
          balance: v.balance || 0,
          companyId: exactCompanyName
        };

        const existingVen = dbVendorMap.get(v.number);
        if (existingVen) {
          if (
            existingVen.name !== venData.name ||
            existingVen.email !== venData.email ||
            existingVen.paymentMethod !== venData.paymentMethod ||
            existingVen.balance !== venData.balance
          ) {
            venUpdates.push({
              where: { id: existingVen.id },
              data: venData
            });
          }
        } else {
          venCreates.push({
            bcId: v.number,
            ...venData
          });
        }
        totalStats.vendors++;
      }

      if (venCreates.length > 0) {
        await prisma.vendor.createMany({
          data: venCreates,
          skipDuplicates: true
        });
      }
      if (venUpdates.length > 0) {
        await chunkedUpdate(venUpdates, (u) => prisma.vendor.update(u));
      }
      } // End of vendors step

      // 5. Fetch Vendor Ledger Entries (Pagos a proveedores)
      if (step === 'all' || step === 'vendorInvoices') {
      console.log(`[${exactCompanyName}] Sincronizando Vendor Ledger Entries...`);
      // Todos los movimientos abiertos, de cualquier Document Type
      const vendorLedgerUrl = `${customApiBaseUrl}/vendorLedgerEntries?$filter=open eq true`;
      
      let allVendorLedgerData: any[] = [];
      try {
        allVendorLedgerData = await fetchODataAllPages(vendorLedgerUrl, accessToken);
      } catch (err: any) {
        console.warn(`[${exactCompanyName}] Failed to fetch VendorLedgerEntries: ${err.message}`);
        continue;
      }
      const allDbVendorsL = await prisma.vendor.findMany({ where: { companyId: exactCompanyName } });
      const dbVendorMapL = new Map(allDbVendorsL.map(v => [v.bcId, v]));

      const allPurchaseInvoices = await prisma.purchaseInvoice.findMany({
        where: { companyId: exactCompanyName },
        select: { id: true, bcId: true, type: true, vendorId: true, amount: true, originalAmount: true, status: true, dueDate: true, paymentMethod: true, schedulePaymentDate: true, percentagePaymentApproval: true, approvalUsers: true, approvedUsers: true, rejectedUsers: true, noPayment: true, noPaymentReason: true }
      });
      const purchaseInvoiceMap = new Map(allPurchaseInvoices.map(p => [p.bcId, p]));

      const piCreates: any[] = [];
      const piUpdates: any[] = [];
      const activeVendorDocumentIds = new Set<string>();
      const pendingPurchaseInvoices = new Map<string, any>();

      for (const entry of allVendorLedgerData) {
        const vendorNo = entry.vendorNo;
        if (!vendorNo) continue;

        const vendor = dbVendorMapL.get(vendorNo);
        if (!vendor) continue;

        const documentNo = entry.documentNo;
        if (!documentNo) continue;

        const entryStatus = entry.open ? 'Open' : 'Closed';
        const dueDate = new Date(entry.dueDate || new Date());
        
        // Fechas de pago
        // Scheduled Payment Date de BC = fecha de pago confirmada. Vacía si no está confirmada (sin usar el vencimiento).
        const schedulePaymentDateStr = entry.scheduledPaymentDateBCT;
        const schedulePaymentDate = schedulePaymentDateStr && !schedulePaymentDateStr.startsWith('0001-01-01') ? new Date(schedulePaymentDateStr) : null;
        
        const noPaymentVal = entry.noPaymentBCT || entry.onHold === 'NO PAGAR';

        const pInvData = {
          amount: parseFloat(entry.remainingAmount !== undefined ? entry.remainingAmount : entry.amount || 0),
          originalAmount: parseFloat(entry.originalAmount !== undefined ? entry.originalAmount : entry.amount || 0),
          dueDate: dueDate,
          schedulePaymentDate: schedulePaymentDate,
          status: entryStatus === 'Open' && dueDate < new Date() ? 'Overdue' : entryStatus,
          paymentMethod: vendor.paymentMethod,
          percentagePaymentApproval: entry.paymentApprovalCRZ !== undefined && entry.paymentApprovalCRZ !== null ? parseFloat(entry.paymentApprovalCRZ) : null,
          approvalUsers: entry.approvedUsersBCT || null,
          approvedUsers: entry.approvedUsersBCT || null,
          rejectedUsers: entry.rejectedUsersBCT || null,
          noPayment: noPaymentVal,
          noPaymentReason: entry.responsibleNoPaymentBCT || entry.onHold || null,
          vendorId: vendor.id,
          companyId: exactCompanyName,
          type: vendorDocType(entry.documentType)
        };

        // Varios movimientos con la misma clave (p. ej. un pago repartido) se suman
        const key = ledgerKey(entry.documentType, String(documentNo), entry.entryNo);
        const pendingPI = pendingPurchaseInvoices.get(key);
        if (pendingPI) {
          pendingPI.amount += pInvData.amount;
          pendingPI.originalAmount += pInvData.originalAmount;
        } else {
          pendingPurchaseInvoices.set(key, pInvData);
        }
        totalStats.purchaseInvoices++;
      }

      for (const [key, pInvData] of pendingPurchaseInvoices) {
        activeVendorDocumentIds.add(key);
        const existingPI = purchaseInvoiceMap.get(key);
        if (existingPI) {
          if (
            existingPI.type !== pInvData.type ||
            existingPI.vendorId !== pInvData.vendorId ||
            existingPI.amount !== pInvData.amount ||
            existingPI.originalAmount !== pInvData.originalAmount ||
            existingPI.status !== pInvData.status ||
            existingPI.paymentMethod !== pInvData.paymentMethod ||
            existingPI.dueDate.getTime() !== pInvData.dueDate.getTime() ||
            (existingPI.schedulePaymentDate?.getTime() || 0) !== (pInvData.schedulePaymentDate?.getTime() || 0) ||
            existingPI.percentagePaymentApproval !== pInvData.percentagePaymentApproval ||
            existingPI.approvalUsers !== pInvData.approvalUsers ||
            existingPI.approvedUsers !== pInvData.approvedUsers ||
            existingPI.rejectedUsers !== pInvData.rejectedUsers ||
            existingPI.noPayment !== pInvData.noPayment ||
            existingPI.noPaymentReason !== pInvData.noPaymentReason
          ) {
            piUpdates.push({
              where: { id: existingPI.id },
              data: pInvData
            });
          }
        } else {
          piCreates.push({
            bcId: key,
            ...pInvData
          });
        }
      }

      if (piCreates.length > 0) {
        await prisma.purchaseInvoice.createMany({
          data: piCreates,
          skipDuplicates: true
        });
      }
      if (piUpdates.length > 0) {
        await chunkedUpdate(piUpdates, (u) => prisma.purchaseInvoice.update(u));
      }

      if (activeVendorDocumentIds.size > 0) {
        await prisma.purchaseInvoice.updateMany({
          where: { 
            companyId: exactCompanyName,
            bcId: { notIn: Array.from(activeVendorDocumentIds) } 
          },
          data: { status: 'Closed' }
        });
      }
      } // End of vendorInvoices step
      
      // 6. Fetch Recurring Payments
      if (step === 'all' || step === 'recurring') {
        console.log(`[${exactCompanyName}] Sincronizando Pagos Recurrentes...`);
        const recurringUrl = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}/ODataV4/Company('${exactCompanyName}')/Recurring_Purchase_Lines_Excel`;
        try {
          const allRecurringData = await fetchODataAllPages(recurringUrl, accessToken);
          const allDbRecurring = await prisma.recurringPayment.findMany({ where: { companyId: exactCompanyName } });
          const dbRecurringMap = new Map(allDbRecurring.map(r => [r.bcCode, r]));

          const recCreates: any[] = [];
          const recUpdates: any[] = [];

          for (const rec of allRecurringData) {
            const code = rec.Code;
            if (!code) continue;

            const recData = {
              companyId: exactCompanyName,
              description: rec.Description || '',
              currencyCode: rec.Currency_Code || 'EUR'
            };

            const existingRec = dbRecurringMap.get(code);
            if (existingRec) {
              if (
                existingRec.description !== recData.description ||
                (existingRec.currencyCode || 'EUR') !== recData.currencyCode
              ) {
                recUpdates.push({
                  where: { id: existingRec.id },
                  data: recData
                });
              }
            } else {
              recCreates.push({
                bcCode: code,
                ...recData
              });
            }
          }

          if (recCreates.length > 0) {
            await prisma.recurringPayment.createMany({ data: recCreates, skipDuplicates: true });
          }
          if (recUpdates.length > 0) {
            await chunkedUpdate(recUpdates, (u) => prisma.recurringPayment.update(u));
          }
        } catch (err: any) {
          console.warn(`[${exactCompanyName}] Failed to fetch Recurring Payments: ${err.message}`);
        }
      } // End of recurring step
      
    } catch (companyError) {
      console.error(`[${exactCompanyName}] Error during sync:`, companyError);
    }
  }

  return totalStats;
}
