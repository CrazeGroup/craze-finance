'use client';

import { useState, useEffect } from 'react';
import { SYNC_STEPS } from '@/lib/syncSteps';
import * as XLSX from 'xlsx';
import { Settings, Upload, Save, Database, Key, Mail } from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';

export default function SettingsPage() {
  const { t, tx } = useT();
  const [apiUrl, setApiUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  // Business Central Config State
  const [bcConfig, setBcConfig] = useState({
    tenantId: '',
    clientId: '',
    clientSecret: '',
    environment: 'Production',
    companyId: ''
  });
  const [syncingBc, setSyncingBc] = useState(false);

  // Email Config State
  const [emailConfig, setEmailConfig] = useState({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    user: '',
    password: '',
    fromName: '',
    fromEmail: ''
  });
  const [savingEmail, setSavingEmail] = useState(false);

  // Load configs on mount
  useEffect(() => {
    fetch('/api/email-config')
      .then(res => res.json())
      .then(data => {
        if (!data.error) {
          setEmailConfig(data);
        }
      })
      .catch(console.error);

    fetch('/api/bc-config')
      .then(res => res.json())
      .then(data => {
        if (!data.error && data.tenantId) {
          setBcConfig(data);
        }
      })
      .catch(console.error);
  }, []);
  


  const saveBcConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bc-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bcConfig),
      });
      if (res.ok) {
        setMessage(t('Business Central settings saved successfully.'));
      } else {
        setMessage(t('Error saving settings.'));
      }
    } catch (error) {
      setMessage(t('Connection error while saving BC.'));
    } finally {
      setLoading(false);
    }
  };

  const syncBcData = async () => {
    setSyncingBc(true);
    const companiesToSync = [
      'CRAZE', 
      'Craze Iberia SL', 
      'Craze UK', // "CRAZE Toys Ltd" en BC
      'CRAZE Group AG', 
      'Craze Entertainment'
    ];
    let totalCust = 0;
    let totalInv = 0;

    try {
      for (const comp of companiesToSync) {
        const steps = SYNC_STEPS;

        for (const step of steps) {
          setMessage(t('Syncing {company} ({step})... Please wait.', { company: comp, step: tx(step.label) }));
          const res = await fetch('/api/sync-bc', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company: comp, step: step.key })
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(t('Error in {company} while syncing {step}: {error}', { company: comp, step: tx(step.label), error: data.error ? tx(data.error) : t('Unknown') }));
          }
          totalCust += data.stats?.customers || 0;
          totalInv += data.stats?.invoices || 0;
        }
      }
      setMessage(t('Sync completed successfully. Customers processed: {customers}, invoices processed: {invoices}', { customers: totalCust, invoices: totalInv }));
    } catch (error: any) {
      setMessage(t('Connection error while syncing: {error}', { error: error.message }));
    } finally {
      setSyncingBc(false);
    }
  };

  const saveEmailConfig = async () => {
    setSavingEmail(true);
    try {
      const res = await fetch('/api/email-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailConfig),
      });
      if (res.ok) {
        setMessage(t('Mail (SMTP) settings saved successfully.'));
      } else {
        setMessage(t('Error saving mail settings.'));
      }
    } catch (error) {
      setMessage(t('Connection error while saving.'));
    } finally {
      setSavingEmail(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="mb-12">
          <h1 className="text-4xl font-extrabold text-black tracking-tight flex items-center gap-4">
            <Settings size={36} className="text-black" />
            {t('Settings')}
          </h1>
          <p className="text-gray-500 mt-2">{t('Manage API connections and manual data upload.')}</p>
        </header>

        {message && (
          <div className="p-4 rounded-xl bg-blue-100 border border-blue-300 text-blue-900 font-bold shadow-sm">
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* API CONFIG BLOCK */}
          <div className="p-8 rounded-3xl backdrop-blur-md bg-gray-50 border border-gray-200 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-32 bg-blue-500/10 rounded-full blur-3xl -mr-16 -mt-16 transition-transform group-hover:scale-110"></div>
            <div className="relative z-10">
              <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                <Database className="text-black" /> {t('Business Central API')}
              </h2>
              
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Tenant ID</label>
                  <input 
                    type="text" 
                    value={bcConfig.tenantId}
                    onChange={(e) => setBcConfig({...bcConfig, tenantId: e.target.value})}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" 
                    className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">{t('Environment')}</label>
                    <input 
                      type="text" 
                      value={bcConfig.environment}
                      onChange={(e) => setBcConfig({...bcConfig, environment: e.target.value})}
                      placeholder="Production" 
                      className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">{t('Company ID (Optional)')}</label>
                    <input 
                      type="text" 
                      value={bcConfig.companyId}
                      onChange={(e) => setBcConfig({...bcConfig, companyId: e.target.value})}
                      placeholder={t('Company identifier')} 
                      className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Client ID (Entra ID App)</label>
                  <input 
                    type="text" 
                    value={bcConfig.clientId}
                    onChange={(e) => setBcConfig({...bcConfig, clientId: e.target.value})}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" 
                    className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Client Secret</label>
                  <div className="relative">
                    <Key className="absolute left-3 top-2.5 text-gray-500" size={18} />
                    <input 
                      type="password" 
                      value={bcConfig.clientSecret}
                      onChange={(e) => setBcConfig({...bcConfig, clientSecret: e.target.value})}
                      placeholder="••••••••••••••••" 
                      className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 pl-10 pr-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    />
                  </div>
                </div>
                
                <div className="flex gap-4 pt-2">
                  <button 
                    onClick={saveBcConfig}
                    disabled={loading}
                    className="flex-1 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl text-gray-900 font-semibold flex items-center justify-center gap-2 transition-all shadow-lg"
                  >
                    <Save size={18} /> {loading ? t('Saving...') : t('Save')}
                  </button>
                  <button 
                    onClick={syncBcData}
                    disabled={syncingBc || !bcConfig.tenantId}
                    className="flex-2 px-6 py-3 bg-black hover:bg-gray-800 text-white rounded-xl text-gray-900 font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Database size={18} /> {syncingBc ? t('Syncing...') : t('Sync Data')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          </div>

        {/* EMAIL CONFIG BLOCK */}
        <div className="p-8 rounded-3xl backdrop-blur-md bg-gray-50 border border-gray-200 shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-32 bg-purple-500/10 rounded-full blur-3xl -mr-16 -mt-16 transition-transform group-hover:scale-110"></div>
          <div className="relative z-10">
            <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
              <Mail className="text-black" /> {t('Mail Settings (SMTP)')}
            </h2>
            <p className="text-gray-300 text-sm mb-6">
              {t('Enter the credentials of your Microsoft mail account (or another provider) to send the real reminders.')}
            </p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">{t('SMTP Server (Host)')}</label>
                <input 
                  type="text" 
                  value={emailConfig.host}
                  onChange={(e) => setEmailConfig({...emailConfig, host: e.target.value})}
                  placeholder="smtp.office365.com" 
                  className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-300 mb-2">{t('Port')}</label>
                  <input 
                    type="number" 
                    value={emailConfig.port}
                    onChange={(e) => setEmailConfig({...emailConfig, port: Number(e.target.value)})}
                    className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={emailConfig.secure}
                      onChange={(e) => setEmailConfig({...emailConfig, secure: e.target.checked})}
                      className="rounded border-gray-600 bg-gray-900 text-purple-500 focus:ring-purple-500"
                    />
                    <span className="text-sm font-medium text-gray-300">SSL/TLS (465)</span>
                  </label>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">{t('User (E-mail)')}</label>
                <input 
                  type="email" 
                  value={emailConfig.user}
                  onChange={(e) => setEmailConfig({...emailConfig, user: e.target.value})}
                  placeholder={t('your_email@company.com')} 
                  className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">{t('App Password')}</label>
                <div className="relative">
                  <Key className="absolute left-3 top-2.5 text-gray-500" size={18} />
                  <input 
                    type="password" 
                    value={emailConfig.password}
                    onChange={(e) => setEmailConfig({...emailConfig, password: e.target.value})}
                    placeholder="••••••••••••••••" 
                    className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 pl-10 pr-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">{t('Sender Name')}</label>
                <input 
                  type="text" 
                  value={emailConfig.fromName}
                  onChange={(e) => setEmailConfig({...emailConfig, fromName: e.target.value})}
                  placeholder={t('E.g. "Craze Finance"')} 
                  className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">{t('Sender E-mail (can be the same user)')}</label>
                <input 
                  type="email" 
                  value={emailConfig.fromEmail}
                  onChange={(e) => setEmailConfig({...emailConfig, fromEmail: e.target.value})}
                  placeholder={t('your_email@company.com')} 
                  className="w-full bg-gray-500 border border-gray-200 rounded-xl py-2 px-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
              </div>
            </div>

            <button 
              onClick={saveEmailConfig}
              disabled={savingEmail}
              className="w-full md:w-auto px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 rounded-xl text-gray-900 font-semibold flex items-center justify-center gap-2 transition-all shadow-lg hover:shadow-purple-500/25"
            >
              <Save size={18} /> {savingEmail ? t('Saving...') : t('Save SMTP Settings')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
