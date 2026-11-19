// Contratos de licencia con Minimum Guarantee (MG). Importes en EUR (divisa de los contratos).
// Los royalties de las ventas de cada territorio consumen solo la garantía de ese territorio.

export type MgInstalment = { date: string; amount: number; label: string };
export type MgGuarantee = {
  id: string;
  territory: string;                      // texto para la tabla
  countries: string[] | 'ALL_EXCEPT';     // países de facturación cuyos royalties consumen esta garantía
  exceptCountries?: string[];             // con 'ALL_EXCEPT': todos salvo estos
  instalments: MgInstalment[];
};
export type MgContract = {
  id: string;
  licence: string;
  owner: string;                          // empresa del grupo titular del contrato (nombre de empresa en BC)
  codes: string[];                        // Royalty Codes de la app que aportan a la MG
  licensor: string;
  licensee: string;
  reference: string;
  start: string;                          // los royalties cuentan desde aquí
  end: string;
  rates: string;
  notes?: string;
  guarantees: MgGuarantee[];
};

const GSA = ['DE', 'AT', 'CH'];
const UK = ['GB', 'JE', 'GG'];

export const MG_CONTRACTS: MgContract[] = [
  {
    id: 'paw-patrol',
    licence: 'PAW PATROL',
    owner: 'CRAZE Group AG',
    codes: ['PAW PATROL COSMETIC', 'PAW PATROL TOYS'],
    licensor: 'Viacom International Inc. (agent Super RTL)',
    licensee: 'CRAZE Group AG (distributors: CRAZE GmbH, CRAZE Toys Ltd, CRAZE Iberia, CRAZE Swiss)',
    reference: 'CMS# 838575',
    start: '2026-01-01',
    end: '2028-12-31',
    rates: 'Category A (cosmetics): 8% / 12% FOB · other: 13% / 18% FOB · own web shop 4% / 7%',
    notes: 'Royalties from DE/AT/CH only consume the GSA guarantee and those from UK/Channel Islands only the UK one.',
    guarantees: [
      {
        id: 'gsa', territory: 'Germany, Austria and Switzerland (GSA)', countries: GSA,
        instalments: [
          { date: '2026-01-01', amount: 90000, label: 'Advance (on signing)' },
          { date: '2026-06-01', amount: 100000, label: 'MG payment' },
          { date: '2026-12-01', amount: 100000, label: 'MG payment' },
          { date: '2027-06-01', amount: 100000, label: 'MG payment' },
          { date: '2027-12-01', amount: 90000, label: 'MG payment' },
        ],
      },
      {
        id: 'uk', territory: 'United Kingdom and Channel Islands', countries: UK,
        instalments: [
          { date: '2026-01-01', amount: 20000, label: 'Advance (on signing)' },
          { date: '2026-06-01', amount: 30000, label: 'MG payment' },
          { date: '2026-12-01', amount: 20000, label: 'MG payment' },
          { date: '2027-06-01', amount: 10000, label: 'MG payment' },
          { date: '2027-12-01', amount: 10000, label: 'MG payment' },
        ],
      },
    ],
  },
  {
    id: 'sponge-bob',
    licence: 'SPONGE BOB',
    owner: 'CRAZE Group AG',
    codes: ['SPONGE BOB COSMETIC', 'SPONGE BOB TOYS'],
    licensor: 'Viacom International Inc. (agent Super RTL)',
    licensee: 'CRAZE Group AG (distributors: CRAZE GmbH, CRAZE Toys Ltd, CRAZE Iberia, CRAZE Swiss)',
    reference: 'CMS# 837957',
    start: '2026-01-01',
    end: '2028-12-31',
    rates: 'Category A (cosmetics): 8% / 12% FOB · other: 13% / 18% FOB · own web shop 4% / 7%',
    notes: 'Royalties from DE/AT/CH only consume the GSA guarantee and those from UK/Channel Islands only the UK one.',
    guarantees: [
      {
        id: 'gsa', territory: 'Germany, Austria and Switzerland (GSA)', countries: GSA,
        instalments: [
          { date: '2026-01-01', amount: 42000, label: 'Advance (on signing)' },
          { date: '2026-06-01', amount: 46500, label: 'MG payment' },
          { date: '2026-12-01', amount: 46500, label: 'MG payment' },
          { date: '2027-06-01', amount: 46500, label: 'MG payment' },
          { date: '2027-12-01', amount: 46500, label: 'MG payment' },
        ],
      },
      {
        id: 'uk', territory: 'United Kingdom and Channel Islands', countries: UK,
        instalments: [
          { date: '2026-01-01', amount: 10000, label: 'Advance (on signing)' },
          { date: '2026-06-01', amount: 15000, label: 'MG payment' },
          { date: '2026-12-01', amount: 10000, label: 'MG payment' },
          { date: '2027-06-01', amount: 10000, label: 'MG payment' },
        ],
      },
    ],
  },
  {
    id: 'bluey',
    licence: 'BLUEY',
    owner: 'CRAZE',
    codes: ['BLUEY'],
    licensor: 'BBC Studios Distribution Ltd',
    licensee: 'CRAZE GmbH',
    reference: 'MD01142',
    start: '2025-08-01',
    end: '2027-06-30',
    rates: '6% / 9% FOB',
    notes: 'Territory DE/AT/CH; passive sales in the EEA also recoup the guarantee (clause 2.2.1). ' +
      'The Advance does not count towards the MG, but together they make up the Total Guaranteed Income of €65,000. Sell-off until 30/09/2027.',
    guarantees: [
      {
        id: 'all', territory: 'Germany, Austria, Switzerland and passive EEA sales', countries: 'ALL_EXCEPT', exceptCountries: UK,
        instalments: [
          { date: '2025-10-24', amount: 30000, label: 'Advance (on signing)' },
          { date: '2026-07-01', amount: 35000, label: 'Minimum Guarantee 1' },
        ],
      },
    ],
  },
];

export const guaranteeCountsCountry = (g: MgGuarantee, country: string) =>
  g.countries === 'ALL_EXCEPT' ? !(g.exceptCountries || []).includes(country) : g.countries.includes(country);
