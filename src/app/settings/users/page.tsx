'use client';

import { useState, useEffect } from 'react';
import { User, Shield, Trash2, Plus, Edit2, Save, X } from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';

// Etiquetas en inglés: se traducen al mostrarlas
const MODULES = [
  { id: 'admin', label: 'Administrator (full access)' },
  { id: 'dashboard', label: 'Main Dashboard' },
  { id: 'riesgos', label: 'Risks' },
  { id: 'recobros', label: 'Collections' },
  { id: 'movimientos', label: 'Open Entries' },
  { id: 'pagos', label: 'Payments to Vendors' },
  { id: 'cashflow', label: 'Cashflow' },
  { id: 'banco', label: 'BANK (statement → General Journal)' },
  { id: 'cierre', label: 'Month-End Close Tracking' },
  { id: 'auditoria', label: 'Audit Log (Activity Log)' },
  { id: 'inventario', label: 'Inventory (Closing)' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'controlling', label: 'Controlling' },
  { id: 'royalties', label: 'Royalties' },
  { id: 'commercial', label: 'Commercial Analysis' },
  { id: 'amazon', label: 'Amazon (margin per customer)' },
  { id: 'sales_returns', label: 'Sales Return Orders (follow-up and comments)' },
  { id: 'logistic_cost', label: 'Logistic Cost (CRAZE GmbH)' },
  { id: 'customer_margin', label: 'Customer Margin (CRAZE GmbH)' },
  { id: 'intercompany', label: 'Intercompany' },
  { id: 'payment_proposal', label: 'Payment Proposal' },
  { id: 'china_payments', label: 'China Payments (CHINA TRF forecast)' },
  { id: 'notas_compra', label: 'Purchase Notes' },
  { id: 'aduanas', label: 'Customs' },
  { id: 'ocr', label: 'OCR' },
  { id: 'dforce', label: 'D-FORCE/MF: D-FORCE and MAILFINISH (Craze Entertainment)' },
  { id: 'magazine_profitability', label: 'Magazine Profitability (Craze Entertainment)' },
  { id: 'mailfinish_inventory', label: 'Mailfinish Inventory (Craze Entertainment)' },
  { id: 'seguros', label: 'Insurance' },
  { id: 'configuracion', label: 'Settings and Users' },
];

export default function UsersPage() {
  const { t, tx, locale } = useT();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    ssoOnly: false,
    permissions: [] as string[]
  });

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      const data = await res.json();
      setUsers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (user: any = null) => {
    if (user) {
      setEditingUserId(user.id);
      let parsedPerms = [];
      try {
        parsedPerms = typeof user.permissions === 'string' ? JSON.parse(user.permissions || '[]') : (Array.isArray(user.permissions) ? user.permissions : []);
      } catch(e) {}
      
      setFormData({
        username: user.username,
        password: '', // Leave blank when editing unless they want to change it
        ssoOnly: false,
        permissions: parsedPerms,
      });
    } else {
      setEditingUserId(null);
      setFormData({
        username: '',
        password: '',
        ssoOnly: false,
        permissions: [],
      });
    }
    setIsModalOpen(true);
  };

  const togglePermission = (moduleId: string) => {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(moduleId)
        ? prev.permissions.filter(p => p !== moduleId)
        : [...prev.permissions, moduleId]
    }));
  };

  const handleSave = async () => {
    if (!formData.username) return alert(t('The username is required'));

    try {
      const url = editingUserId ? `/api/users/${editingUserId}` : '/api/users';
      const method = editingUserId ? 'PUT' : 'POST';
      
      const payload: any = {
        username: formData.username,
        permissions: formData.permissions
      };
      
      if (formData.password) {
        payload.password = formData.password;
      } else if (formData.ssoOnly) {
        payload.ssoOnly = true;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setIsModalOpen(false);
        fetchUsers();
      } else {
        const errorData = await res.json();
        alert(errorData.error ? tx(errorData.error) : t('Error saving the user'));
      }
    } catch (e) {
      alert(t('Connection error'));
    }
  };

  const handleDelete = async (id: number) => {
    if (id === 1) return alert(t('The main administrator cannot be deleted'));
    if (!confirm(t('Are you sure you want to delete this user?'))) return;

    try {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchUsers();
      } else {
        const errorData = await res.json();
        alert(errorData.error ? tx(errorData.error) : t('Error deleting'));
      }
    } catch (e) {
      alert(t('Connection error'));
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <User className="text-black" /> 
            {t('User Management')}
          </h2>
          <p className="text-gray-500 mt-1">{t('Create users and assign access permissions to the modules')}</p>
        </div>
        <button 
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-gray-900 rounded-lg shadow-lg font-medium transition-colors"
        >
          <Plus size={16} /> {t('Add User')}
        </button>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-sm font-medium text-gray-500 bg-gray-50">
              <th className="p-4">{t('Username')}</th>
              <th className="p-4">{t('Permissions')}</th>
              <th className="p-4">{t('Creation Date')}</th>
              <th className="p-4 text-center">{t('Actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-slate-500">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-400 mx-auto"></div>
                </td>
              </tr>
            ) : users.map(user => {
              let perms = [];
              try {
                perms = typeof user.permissions === 'string' ? JSON.parse(user.permissions || '[]') : (Array.isArray(user.permissions) ? user.permissions : []);
              } catch(e) {}
              
              return (
                <tr key={user.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="p-4 text-gray-900 font-medium flex items-center gap-2">
                    {user.id === 1 && <span title="Super Admin"><Shield size={14} className="text-orange-400" /></span>}
                    {user.username}
                    {!user.hasPassword && <span className="px-2 py-0.5 text-xs font-normal rounded bg-sky-100 text-sky-700 border border-sky-200" title={t('No password: signs in with Microsoft')}>Microsoft</span>}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap gap-1">
                      {perms.includes('configuracion') || perms.includes('admin') ? (
                        <span className="px-2 py-0.5 text-xs rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
                          {t('Full Access')}
                        </span>
                      ) : (
                        perms.map((p: string) => (
                          <span key={p} className="px-2 py-0.5 text-xs rounded bg-indigo-500/20 text-black border border-indigo-500/30 capitalize">
                            {p}
                          </span>
                        ))
                      )}
                      {perms.length === 0 && <span className="text-slate-500 text-xs italic">{t('None')}</span>}
                    </div>
                  </td>
                  <td className="p-4 text-gray-500 text-sm">
                    {new Date(user.createdAt).toLocaleDateString(locale)}
                  </td>
                  <td className="p-4">
                    <div className="flex justify-center gap-2">
                      <button 
                        onClick={() => handleOpenModal(user)}
                        className="p-1.5 text-black hover:bg-blue-400/20 rounded-md transition-colors"
                        title={t('Edit')}
                      >
                        <Edit2 size={16} />
                      </button>
                      <button 
                        onClick={() => handleDelete(user.id)}
                        disabled={user.id === 1}
                        className="p-1.5 text-gray-500 font-bold hover:bg-red-400/20 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title={user.id === 1 ? t('Protected admin') : t('Delete')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden transform transition-all">
            <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gray-50">
              <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                {editingUserId ? <Edit2 className="text-black" /> : <Plus className="text-black" />}
                {editingUserId ? t('Edit User') : t('New User')}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-gray-500 hover:text-gray-900 transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">{t('Username')} <span className="text-slate-500 text-xs font-normal">{t('(Microsoft e-mail to sign in with Microsoft)')}</span></label>
                <input 
                  type="text" 
                  value={formData.username}
                  onChange={e => setFormData({...formData, username: e.target.value})}
                  className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2 text-gray-900 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">
                  {t('Password')} <span className="text-slate-500 text-xs font-normal">{editingUserId ? t('(Leave blank to keep it unchanged)') : t('(Optional: without a password the user can only sign in with Microsoft)')}</span>
                </label>
                <input 
                  type="password" 
                  value={formData.password}
                  disabled={formData.ssoOnly}
                  onChange={e => setFormData({...formData, password: e.target.value})}
                  className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2 text-gray-900 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100"
                />
                {editingUserId && (
                  <label className="flex items-center gap-2 mt-2 text-sm text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.ssoOnly}
                      onChange={e => setFormData({...formData, ssoOnly: e.target.checked, password: ''})}
                    />
                    {t('Remove the password (sign in with Microsoft only)')}
                  </label>
                )}
              </div>

              <div className="pt-2">
                <label className="block text-sm font-medium text-gray-600 mb-2">{t('Permissions (Accessible Modules)')}</label>
                <div className="bg-black/20 rounded-xl border border-gray-100 p-4 space-y-3 max-h-48 overflow-y-auto">
                  {MODULES.map(mod => (
                    <label key={mod.id} className="flex items-center gap-3 cursor-pointer group">
                      <div className="relative flex items-center">
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          checked={formData.permissions.includes(mod.id)}
                          onChange={() => togglePermission(mod.id)}
                        />
                        <div className="w-5 h-5 rounded border-2 border-slate-500 peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-colors flex items-center justify-center group-hover:border-indigo-400">
                          {formData.permissions.includes(mod.id) && <Shield size={12} className="text-gray-900" />}
                        </div>
                      </div>
                      <span className="text-sm text-gray-600 group-hover:text-gray-900 transition-colors">{t(mod.label)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-4 flex justify-end gap-3">
                <button 
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                >
                  {t('Cancel')}
                </button>
                <button 
                  onClick={handleSave}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-gray-900 rounded-lg font-medium shadow-lg transition-colors"
                >
                  <Save size={16} />
                  {editingUserId ? t('Update') : t('Create User')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
