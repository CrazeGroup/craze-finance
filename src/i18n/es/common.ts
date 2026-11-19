// Castellano: texto inglés del código → castellano
const es: Record<string, string> = {
  // Aplicación (layout)
  'Craze Finance': 'Craze Finanzas',
  'Financial management and optimisation for Craze': 'Gestión y optimización financiera para Craze',

  // Inicio de sesión
  'Microsoft sign-in is not configured yet.': 'El inicio de sesión con Microsoft aún no está configurado.',
  'Your Microsoft account does not have access to this application.': 'Tu cuenta de Microsoft no tiene acceso a esta aplicación.',
  'Microsoft sign-in was cancelled.': 'Se ha cancelado el inicio de sesión con Microsoft.',
  'The Microsoft sign-in session has expired. Please try again.': 'La sesión de inicio con Microsoft ha caducado. Inténtalo de nuevo.',
  'Could not sign in with Microsoft.': 'No se ha podido iniciar sesión con Microsoft.',
  'Sign-in error': 'Error al iniciar sesión',
  'Connection error': 'Error de conexión',
  'Sign In': 'Iniciar Sesión',
  'Access your financial dashboard': 'Accede a tu panel financiero',
  'Sign in with Microsoft': 'Iniciar sesión con Microsoft',
  'or with username and password': 'o con usuario y contraseña',
  'Username': 'Usuario',
  'your.username': 'tu.usuario',
  'Password': 'Contraseña',
  'Log in': 'Entrar',

  // Ficha de cliente (Riesgos)
  'Method of Payment': 'Forma de Pago',
  'Open Balance': 'Saldo Abierto',
  'Overdue Balance': 'Saldo Vencido',
  'Risk Limit': 'Límite de Riesgo',
  'Suggested Action': 'Acción Sugerida',

  // Enlace al PDF de BC
  'Open the PDF attached in BC': 'Abrir el PDF adjunto en BC',

  // Comentarios de factura
  'Could not delete the comment': 'No se pudo borrar el comentario',
  'Could not save the comment: {error}': 'No se pudo guardar el comentario: {error}',
  'Delete this comment?': '¿Borrar este comentario?',
  'Comments': 'Comentarios',
  'No comments yet.': 'Sin comentarios todavía.',
  'Delete comment': 'Borrar comentario',
  'Write a comment… (also shown in Cashflow and Collections)': 'Escribe un comentario… (se ve también en Cashflow y Recobros)',
  'Add comment': 'Añadir comentario',

  // Botón "Algo está mal"
  'Could not send': 'No se ha podido enviar',
  'Send another comment': 'Enviar otro comentario',
  'Feedback sent': 'Feedback enviado',
  'Report an error in the proposal so the logic can be fixed': 'Avisar de un error en la propuesta, para corregir la lógica',
  'Something is wrong': 'Algo está mal',
  'What is wrong?': '¿Qué está mal?',
  'E.g.: the vendor is VE-00066, not VE-00078 / it is a credit memo / the invoice no. is the one at the top right': 'P. ej.: el proveedor es VE-00066, no VE-00078 / es un abono / el nº de factura es el de arriba a la derecha',
  'Screenshot {n}': 'Captura {n}',
  'Remove': 'Quitar',
  'Attach screenshot': 'Adjuntar captura',
  'Paste a screenshot with Cmd/Ctrl+V in the text, drag it here or attach it (up to 6). What is on screen is attached too (proposal, changes and the PDF if there is one).': 'Pega una captura con Cmd/Ctrl+V en el texto, arrástrala aquí o adjúntala (hasta 6). Se adjunta también lo que hay en pantalla (propuesta, cambios y el PDF si lo hay).',
  'Send feedback': 'Enviar feedback',

  // Conectar mi correo
  'Mail connected: your reminders will be sent from your own mailbox (and will appear in your Sent Items).': 'Correo conectado: tus recordatorios saldrán desde tu propio buzón (y quedarán en tus Elementos enviados).',
  'The selected Microsoft account is not the one of your app user. Please try again with your account.': 'La cuenta de Microsoft elegida no es la de tu usuario de la app. Vuelve a intentarlo con tu cuenta.',
  'Microsoft did not grant permanent access to the mailbox. Please try again.': 'Microsoft no ha dado acceso permanente al correo. Vuelve a intentarlo.',
  'Could not connect the mailbox.': 'No se pudo conectar el correo.',
  'A Microsoft 365 administrator needs to approve the application\'s "Mail.Send" (delegated) permission.': 'Hace falta que un administrador de Microsoft 365 apruebe el permiso "Mail.Send" (delegado) de la aplicación.',

  // Recordatorio al cliente (diálogo)
  '{n} invoice PDF(s) attached.': '{n} PDF de factura adjuntos.',
  'No PDF in BC: {list}': 'Sin PDF en BC: {list}',
  'Reminder {level} sent from {from} to {to}': 'Recordatorio {level} enviado desde {from} a {to}',
  '(copy to {cc})': '(copia a {cc})',
  'Error sending the reminder: {error}': 'Error al enviar el recordatorio: {error}',
  'Customer reminder': 'Recordatorio al cliente',
  '{n} invoice(s)': '{n} factura(s)',
  'Reminder no. {n}': '{n}º recordatorio',
  'suggested': 'sugerido',
  'Normal': 'Normal',
  'Salesperson in copy': 'Comercial en copia',
  'Insurance notice': 'Aviso aseguradora',
  'Will be sent from': 'Se enviará desde',
  '(it stays in its Sent Items).': '(queda en sus Elementos enviados).',
  'Cannot send from': 'No se puede enviar desde',
  'Send to': 'Para',
  'customer@company.com (several separated by commas)': 'cliente@empresa.com (varios separados por coma)',
  'The customer has no e-mail on their BC card.': 'El cliente no tiene email en su ficha de BC.',
  'Looking up the salesperson\'s e-mail in BC…': 'Buscando el email del comercial en BC…',
  'salesperson\'s e-mail': 'email del comercial',
  'The salesperson has no e-mail in BC: enter it here.': 'El comercial no tiene email en BC: escríbelo aquí.',
  'The customer has no salesperson assigned: enter the e-mail.': 'El cliente no tiene comercial asignado: escribe el email.',
  'Add insurance notice': 'Añadir aviso de aseguradora',
  'Attach the PDF of the sales invoices': 'Adjuntar el PDF de las facturas de venta',
  'BC printout of each selected invoice, in addition to the summary (takes a few more seconds per invoice)': 'Impresión de BC de cada factura seleccionada, además del resumen (tarda unos segundos más por factura)',
  'Subject': 'Asunto',
  'Message (also included in the PDF)': 'Mensaje (también va en el PDF)',
  'View PDF': 'Ver PDF',
  'Cancel': 'Cancelar',
  'Sending…': 'Enviando…',
  'Send reminder no. {n}': 'Enviar {n}º recordatorio',

  // Genéricos
  'Loading…': 'Cargando…',
  'Refresh': 'Actualizar',
  'Could not save the changes': 'No se ha podido guardar',
  'user': 'usuario',
};
export default es;
