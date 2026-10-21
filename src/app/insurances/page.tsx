'use client';

import { useState, useEffect, useRef } from 'react';
import { ShieldCheck, Plus, FileText, Download, Trash2, Send, Bot, User as UserIcon, Loader2, Save, Edit2 } from 'lucide-react';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';
import { upload } from '@vercel/blob/client';

interface Insurance {
  id: number;
  companyId: string;
  description: string;
  startDate: string;
  endDate: string;
  fileName: string | null;
  fileUrl?: string | null;
  attachments?: { fileName: string, fileBase64?: string, fileUrl?: string }[];
}

interface ChatMessage {
  role: 'user' | 'bot';
  content: string;
}

export default function InsurancesPage() {
  const { selectedCompany } = useCompany();
  const [insurances, setInsurances] = useState<Insurance[]>([]);
  const [loading, setLoading] = useState(true);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'bot', content: '¡Hola! Soy tu asistente de seguros. Pregúntame sobre coberturas, condiciones o cualquier duda que tengas sobre tus pólizas activas.' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [editingInsuranceId, setEditingInsuranceId] = useState<number | null>(null);
  const [formData, setFormData] = useState({
    companyId: (selectedCompany && selectedCompany !== 'ALL') ? selectedCompany : 'CRAZE',
    description: '',
    startDate: '',
    endDate: '',
    fileName: '',
    fileBase64: '',
    fileUrl: '',
    attachments: [] as {fileName: string, fileBase64?: string, fileUrl?: string}[]
  });
  const [isExtracting, setIsExtracting] = useState(false);

  useEffect(() => {
    if (selectedCompany) fetchInsurances();
  }, [selectedCompany]);

  useEffect(() => {
    if (isModalOpen) {
      setFormData(prev => ({ ...prev, companyId: (selectedCompany && selectedCompany !== 'ALL') ? selectedCompany : 'CRAZE' }));
    }
  }, [isModalOpen, selectedCompany]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchInsurances = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/insurances');
      const data = await res.json();
      setInsurances(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const validFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (validFiles.length !== files.length) {
      alert('Algunos archivos no son PDF. Solo se han seleccionado los PDFs.');
    }
    if (validFiles.length === 0) return;

    let totalSize = 0;
    validFiles.forEach(f => totalSize += f.size);
    // Vercel Blob client-side uploads handle large files easily, but we can set a generous limit (e.g. 50MB)
    if (totalSize > 50 * 1024 * 1024) {
      alert('El tamaño total de los archivos supera el límite de 50MB.');
      return;
    }

    setIsExtracting(true);
    
    let newAttachments = [...(formData.attachments || [])];

    try {
      setIsExtracting(true);
      // 1. Upload files to Vercel Blob with unique names to prevent collisions
      const uploadPromises = validFiles.map(async (file) => {
        const uniqueFilename = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${file.name}`;
        const newBlob = await upload(uniqueFilename, file, {
          access: 'public',
          handleUploadUrl: '/api/upload',
        });
        return { fileName: file.name, fileUrl: newBlob.url };
      });

      const uploadedFiles = await Promise.all(uploadPromises);
      newAttachments = [...newAttachments, ...uploadedFiles];
      
      setFormData(prev => ({ ...prev, attachments: newAttachments }));
    } catch (error: any) {
      console.error("Error al subir a Vercel Blob:", error);
      alert(`Error en paso 1 (Subiendo a Blob): ${error?.message || 'Fallo desconocido'}`);
      setIsExtracting(false);
      return; // Stop here if upload fails
    }

    try {
      // 2. Call Extract API with the URLs
      const res = await fetch('/api/insurances/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachments: newAttachments })
      });
      
      if (res.ok) {
        const data = await res.json();
        setFormData(prev => ({
          ...prev,
          description: data.description || prev.description,
          startDate: data.startDate || prev.startDate,
          endDate: data.endDate || prev.endDate
        }));
      } else {
        const errorData = await res.json().catch(() => null);
        const errorMessage = errorData?.error || 'Error desconocido';
        alert(`Error en paso 2 (Extracción): El servidor devolvió status ${res.status}. Detalles: ${errorMessage}`);
      }
    } catch (error: any) {
      console.error("Error al extraer datos con Gemini:", error);
      alert(`Error en paso 2 (Llamada a Gemini): ${error?.message || 'Fallo desconocido'}`);
    } finally {
      setIsExtracting(false);
    }
  };

  const removeAttachment = (indexToRemove: number) => {
    setFormData(prev => ({
      ...prev,
      attachments: prev.attachments.filter((_, idx) => idx !== indexToRemove)
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.description || !formData.startDate || !formData.endDate) {
      return alert('Rellena los campos obligatorios');
    }

    setIsUploading(true);
    try {
      const url = editingInsuranceId ? `/api/insurances/${editingInsuranceId}` : '/api/insurances';
      const method = editingInsuranceId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (res.ok) {
        setIsModalOpen(false);
        setEditingInsuranceId(null);
        setFormData({ companyId: (selectedCompany && selectedCompany !== 'ALL') ? selectedCompany : 'CRAZE', description: '', startDate: '', endDate: '', fileName: '', fileBase64: '', fileUrl: '', attachments: [] });
        fetchInsurances();
      } else {
        if (res.status === 413) {
          alert('Error: El archivo es demasiado grande para ser procesado por el servidor.');
        } else {
          try {
            const err = await res.json();
            alert(err.error || 'Error al guardar');
          } catch(e) {
            alert(`Error de servidor (${res.status}). Puede que el archivo sea muy grande.`);
          }
        }
      }
    } catch (e) {
      alert('Error de red. Comprueba tu conexión a internet.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('¿Estás seguro de eliminar este seguro?')) return;
    try {
      const res = await fetch(`/api/insurances/${id}`, { method: 'DELETE' });
      if (res.ok) fetchInsurances();
    } catch (e) {
      alert('Error de conexión');
    }
  };

  const handleDownload = async (id: number, legacyFileName: string | null) => {
    try {
      const res = await fetch(`/api/insurances/${id}`);
      const data = await res.json();
      
      let parsedAttachments: any[] = [];
      if (data.attachments) {
        if (typeof data.attachments === 'string') {
          try { parsedAttachments = JSON.parse(data.attachments); } catch(e){}
        } else if (Array.isArray(data.attachments)) {
          parsedAttachments = data.attachments;
        }
      }

      let downloadedCount = 0;

      // Download legacy file if present
      if (data.fileBase64 && legacyFileName) {
        const a = document.createElement('a');
        a.href = data.fileBase64;
        a.download = legacyFileName;
        a.click();
        downloadedCount++;
      }

      // Download all attachments
      parsedAttachments.forEach(att => {
        const base64Str = att.fileData || att.fileBase64;
        if (base64Str && att.fileName) {
          const a = document.createElement('a');
          a.href = base64Str.startsWith('data:') ? base64Str : `data:application/pdf;base64,${base64Str}`;
          a.download = att.fileName;
          a.click();
          downloadedCount++;
        } else if (att.fileUrl) {
          window.open(att.fileUrl, '_blank');
          downloadedCount++;
        }
      });

      if (downloadedCount === 0) {
        alert('Este seguro no tiene archivos adjuntos');
      }
    } catch (e) {
      alert('Error al descargar');
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const userMessage = chatInput;
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/insurances/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage })
      });
      
      if (!res.ok) {
        const textError = await res.text();
        console.error("Bot error response:", res.status, textError);
        let parsedErr = "Error desconocido";
        try { parsedErr = JSON.parse(textError).error || textError; } catch(e) { parsedErr = textError.substring(0, 100); }
        setMessages(prev => [...prev, { role: 'bot', content: `❌ Error del servidor (${res.status}): ${parsedErr}` }]);
        return;
      }

      const data = await res.json();
      
      if (data.error) {
        setMessages(prev => [...prev, { role: 'bot', content: `❌ Error: ${data.error}` }]);
      } else {
        setMessages(prev => [...prev, { role: 'bot', content: data.reply }]);
      }
    } catch (e: any) {
      console.error(e);
      setMessages(prev => [...prev, { role: 'bot', content: `❌ Error de red/conexión: ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="p-8 w-full h-[calc(100vh-2rem)] flex flex-col">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <ShieldCheck className="text-black w-8 h-8" /> 
            Gestión de Seguros
          </h1>
          <p className="text-gray-500 mt-1">Controla las pólizas de {selectedCompany} y consulta dudas con la IA</p>
        </div>
        <button 
          onClick={() => {
            setEditingInsuranceId(null);
            setIsModalOpen(true);
          }}
          className="flex items-center gap-2 px-5 py-2.5 bg-black hover:bg-gray-800 text-white rounded-lg shadow-lg font-medium transition-colors"
        >
          <Plus size={18} /> Añadir Seguro
        </button>
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
        
        {/* Lado Izquierdo: Lista de Seguros */}
        <div className="w-1/2 flex flex-col bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <FileText size={18} className="text-blue-600" />
              Pólizas Activas
            </h2>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="text-center py-10 text-gray-400">Cargando pólizas...</div>
            ) : insurances.length === 0 ? (
              <div className="text-center py-10 text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
                No hay seguros registrados para {selectedCompany}.
              </div>
            ) : (
              <div className="space-y-3">
                {insurances.map(policy => {
                  const today = new Date();
                  const end = new Date(policy.endDate);
                  const start = new Date(policy.startDate);
                  const isActive = today >= start && today <= end;
                  
                  // Check if expiring in less than 3 months
                  const threeMonthsFromNow = new Date();
                  threeMonthsFromNow.setMonth(today.getMonth() + 3);
                  const isExpiringSoon = isActive && end <= threeMonthsFromNow;

                  let statusText = 'CADUCADO';
                  let statusColor = 'bg-red-100 text-red-700';
                  
                  if (isActive) {
                    if (isExpiringSoon) {
                      statusText = 'RENOVAR PRONTO';
                      statusColor = 'bg-red-100 text-red-700';
                    } else {
                      statusText = 'ACTIVO';
                      statusColor = 'bg-green-100 text-green-700';
                    }
                  }

                  return (
                    <div key={policy.id} className="p-4 border border-gray-100 rounded-xl hover:shadow-md transition-shadow bg-white flex items-center justify-between group">
                      <div>
                        <h3 className="font-bold text-gray-900 flex items-center gap-2">
                          {policy.description}
                          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full font-medium">
                            {policy.companyId}
                          </span>
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">
                          {start.toLocaleDateString()} - {end.toLocaleDateString()}
                        </p>
                        <div className="flex items-center gap-3 mt-2">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${statusColor}`}>
                            {statusText}
                          </span>
                          {(policy.attachments?.length || policy.fileName) ? (
                            <span className="flex items-center gap-1 text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                              <FileText size={12} />
                              {((policy.attachments?.length || 0) + (policy.fileName ? 1 : 0))} documento(s)
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex gap-2 items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => {
                            setFormData({
                              companyId: selectedCompany || 'CRAZE',
                              description: policy.description,
                              startDate: policy.startDate.split('T')[0],
                              endDate: policy.endDate.split('T')[0],
                              fileName: '',
                              fileBase64: '',
                              fileUrl: '',
                              attachments: policy.attachments || []
                            });
                            setEditingInsuranceId(policy.id);
                            setIsModalOpen(true);
                          }}
                          className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                          title="Editar Seguro"
                        >
                          <Edit2 size={18} />
                        </button>
                        {(policy.fileName || (policy.attachments && policy.attachments.length > 0)) && (
                          <button 
                            onClick={() => handleDownload(policy.id, policy.fileName)}
                            className="p-2 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                            title="Descargar Documentos"
                          >
                            <Download size={18} />
                          </button>
                        )}
                        <button 
                          onClick={() => handleDelete(policy.id)}
                          className="p-2 text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                          title="Eliminar Seguro"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Lado Derecho: Chatbot de IA */}
        <div className="w-1/2 flex flex-col bg-gray-50 border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-white flex items-center justify-between">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <Bot size={20} className="text-purple-600" />
              Asistente de Seguros (IA)
            </h2>
            <span className="text-xs font-medium px-2 py-1 bg-purple-100 text-purple-700 rounded-full">Lee tus pólizas (PDF)</span>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 max-w-[85%] ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-indigo-100 text-indigo-600' : 'bg-purple-100 text-purple-600'}`}>
                  {msg.role === 'user' ? <UserIcon size={16} /> : <Bot size={16} />}
                </div>
                <div className={`p-3 rounded-2xl text-sm ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm whitespace-pre-wrap'}`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center shrink-0">
                  <Bot size={16} />
                </div>
                <div className="p-4 bg-white border border-gray-200 rounded-2xl rounded-tl-sm shadow-sm flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 size={14} className="animate-spin" /> Consultando pólizas...
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-4 bg-white border-t border-gray-200">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input 
                type="text" 
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Ej: ¿El seguro cubre robo en los almacenes?"
                className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 text-sm"
              />
              <button 
                type="submit" 
                disabled={chatLoading || !chatInput.trim()}
                className="px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center"
              >
                <Send size={18} />
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Modal de Nuevo Seguro */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-xl font-bold flex items-center gap-2">
                {editingInsuranceId ? (
                  <><Edit2 className="text-indigo-600" /> Editar/Renovar Póliza</>
                ) : (
                  <><Plus className="text-indigo-600" /> Añadir Póliza de Seguro</>
                )}
              </h3>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Empresa</label>
                <select
                  value={formData.companyId}
                  onChange={e => setFormData({...formData, companyId: e.target.value})}
                  className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  required
                >
                  {COMPANIES.filter(c => c !== 'ALL').map(comp => (
                    <option key={comp} value={comp}>{comp}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Descripción / Nombre</label>
                <input 
                  type="text" 
                  value={formData.description}
                  onChange={e => setFormData({...formData, description: e.target.value})}
                  className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2"
                  placeholder="Ej: Seguro de RC Plus"
                  required
                />
              </div>
              <div className="flex gap-4">
                <div className="w-1/2">
                  <label className="block text-sm font-medium text-gray-600 mb-1">Fecha de Inicio</label>
                  <input 
                    type="date" 
                    value={formData.startDate}
                    onChange={e => setFormData({...formData, startDate: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2"
                    required
                  />
                </div>
                <div className="w-1/2">
                  <label className="block text-sm font-medium text-gray-600 mb-1">Fecha de Fin</label>
                  <input 
                    type="date" 
                    value={formData.endDate}
                    onChange={e => setFormData({...formData, endDate: e.target.value})}
                    className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2"
                    required
                  />
                </div>
              </div>
              <div className="flex flex-col space-y-1">
                <label className="text-sm font-medium text-gray-700">Documentos Adjuntos (Múltiples PDF)</label>
                <div className="flex items-center space-x-2">
                  <input type="file" multiple accept=".pdf" onChange={handleFileChange} className="w-full rounded-md border border-gray-300 p-2 text-sm file:mr-4 file:rounded-full file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100" />
                  {isExtracting && <Loader2 className="h-5 w-5 animate-spin text-blue-600" />}
                </div>
                {isExtracting ? (
                  <p className="text-xs text-blue-600 font-medium">✨ Leyendo pólizas con IA...</p>
                ) : (
                  <p className="text-xs text-gray-500">Puedes seleccionar varios PDFs a la vez. La IA los leerá todos para extraer la información.</p>
                )}
                
                {/* List of current attachments */}
                {formData.attachments && formData.attachments.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs font-semibold text-gray-600">Archivos seleccionados:</p>
                    <div className="max-h-32 overflow-y-auto space-y-1 pr-2">
                      {formData.attachments.map((att, idx) => (
                        <div key={idx} className="flex justify-between items-center bg-gray-50 border border-gray-200 rounded p-2">
                          <span className="text-xs text-gray-700 truncate flex-1 flex items-center gap-1">
                            <FileText size={12} className="text-indigo-500" />
                            {att.fileName}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(idx)}
                            className="text-red-500 hover:text-red-700 p-1"
                            title="Eliminar archivo"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t border-gray-100">
                <button 
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    setEditingInsuranceId(null);
                  }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-50 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  disabled={isUploading}
                  className="px-4 py-2 bg-black hover:bg-gray-800 text-white rounded-lg font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  {isUploading ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  {isUploading ? 'Guardando...' : (editingInsuranceId ? 'Actualizar' : 'Guardar')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
