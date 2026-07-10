/**
 * Operator-facing (internal) strings for the Telegram bridge + routing alerts.
 * These are NOT customer-facing business copy, so they live here rather than in
 * the skill JSON. Centralized to avoid scattering literals across services.
 */
const customerMessageBody = (phone: string, text: string): string => `Nuevo mensaje de ${phone}\n\n${text}`;

export const bridgeMessages = {
  bridgeOnlyForApiLine: 'Esta linea esta configurada como referral. Responde desde WhatsApp Business app, no desde Telegram bridge.',
  leadNotFound: (phone: string): string => `No se encontro conversacion para ${phone}`,
  leadNotAssigned: 'Lead sin asignacion. Espera alerta de asignacion o revisa routing.',
  leadAssignedToOther: 'Lead asignado a otro agente. No puedes responder desde este chat.',
  ownerOnlyCommand: 'Comando restringido al owner.',
  customerOptedOut: 'El cliente hizo opt-out. No se puede enviar mensaje.',
  botPaused: 'El bot esta en pausa. Reactiva con /resume antes de responder.',
  serviceWindowClosed: 'Fuera de la ventana de 24h de WhatsApp. El cliente debe escribir primero o usa una plantilla aprobada.',
  noActiveChat: 'No hay chat activo.',
  chatClosed: (phone: string): string => `Chat cerrado con ${phone}.`,
  sent: (phone: string): string => `Enviado a ${phone}`,
  sendFailed: (reason: string): string => `Error enviando WhatsApp desde bridge: ${reason}`,
  bridgeUsage: 'Uso: /bridge <telefono>  (alias: /chat)',
  leadUsage: 'Uso: /lead <telefono>',
  bookingUsage: 'Uso: /booking <telefono>',
  deleteUsage: 'Uso: /delete <telefono>',
  deleteDone: (params: {
    phone: string;
    conversations: number;
    messages: number;
    processedMessages: number;
    aiUsage: number;
    ownerAlerts: number;
    mediaSends: number;
    bridgeSessions: number;
    followUpEvents: number;
  }): string =>
    [
      `🧹 Datos eliminados para ${params.phone}`,
      `conversations: ${params.conversations}`,
      `messages: ${params.messages}`,
      `processed webhooks: ${params.processedMessages}`,
      `ai usage: ${params.aiUsage}`,
      `owner alerts: ${params.ownerAlerts}`,
      `media sends: ${params.mediaSends}`,
      `bridge sessions: ${params.bridgeSessions}`,
      `follow-up events: ${params.followUpEvents}`,
    ].join('\n'),
  alreadyBooked: (sinceDay: string): string => `Ya estaba confirmado desde ${sinceDay}.`,
  bookingConfirmed: (who: string): string => `Reserva confirmada para ${who}. Se notifico a todas las lineas.`,
  botPausedConfirmed: 'Bot pausado. Se notifico a todas las lineas.',
  botResumedConfirmed: 'Bot reactivado. Se notifico a todas las lineas.',
  botPausedBroadcast: (who: string): string =>
    `⏸️ Bot PAUSADO por ${who}\nEl bot no respondera a clientes hasta /resume.`,
  botResumedBroadcast: (who: string): string =>
    `▶️ Bot REACTIVADO por ${who}\nEl bot esta respondiendo a clientes de nuevo.`,
  bookingBroadcast: (params: { who: string; phone: string; name: string | null }): string =>
    `🎉 Nueva reserva de *${params.name ?? params.phone}* — ${params.phone}\nConfirmada por ${params.who}.\nUn lead mas convertido para el equipo 👏`,
  chatActiveHeader: (phone: string): string =>
    `Chat activo con ${phone}. Escribe mensajes normales aqui para responder por WhatsApp.\nUsa /end para cerrar.`,
  newCustomerMessage: (phone: string, text: string): string => customerMessageBody(phone, text),
  newCustomerImage: (phone: string, caption: string): string =>
    caption.trim().length > 0
      ? `Imagen de ${phone}\n\n${caption}`
      : `Imagen de ${phone}`,
  newCustomerAudio: (phone: string): string => `Audio de ${phone}`,
  newCustomerVideo: (phone: string): string => `Video de ${phone}`,
  dormantBridgeNotice: (phone: string, text: string): string =>
    `${customerMessageBody(phone, text)}\n\nUsa /bridge ${phone} para tomar control.`,
  dormantBridgeImageNotice: (phone: string): string =>
    `${phone} envio una imagen.\n\nUsa /bridge ${phone} para tomar control.`,
  dormantBridgeAudioNotice: (phone: string): string =>
    `${phone} envio un audio.\n\nUsa /bridge ${phone} para tomar control.`,
  dormantBridgeVideoNotice: (phone: string): string =>
    `${phone} envio un video.\n\nUsa /bridge ${phone} para tomar control.`,
  customerImageFailed: (phone: string): string =>
    `${phone} envio una imagen pero no se pudo descargar. Pidele al cliente que la reenvie.`,
  customerAudioFailed: (phone: string): string =>
    `${phone} envio un audio pero no se pudo descargar. Pidele al cliente que lo reenvie.`,
  imageNoActiveChat: 'No hay chat activo. Abre uno con /bridge <telefono> antes de enviar una imagen.',
  postHandoffCustomerMessage: (params: { phone: string; text: string; bridge: boolean; displayNumber?: string }): string => {
    const action = params.bridge
      ? `Usa /bridge ${params.phone} para responder desde el bridge.`
      : `Responder desde WhatsApp Business app: ${params.displayNumber ?? 'linea asignada'}.`;
    return `Nuevo mensaje del lead ${params.phone}\nWhatsApp: https://wa.me/${params.phone}\n\n${params.text}\n\n${action}`;
  },
  fallbackAlert: (body: string): string => `[FALLBACK] ${body}`,
  alertFooter: (params: { label: string; agentName: string; type: string; bridge: boolean; displayNumber?: string }): string => {
    const action = params.bridge
      ? 'Responder con /bridge <telefono> y luego escribir aqui.'
      : `El asesor debe escribir desde ${params.displayNumber ?? 'la linea asignada'}.`;
    return `Asignado: ${params.label} (${params.agentName})\nRuta: ${params.type}\n${action}`;
  },
  returnbotUsage: 'Uso: /returnbot <telefono>',
  returnbotBooked: 'Lead confirmado (booked). No se puede devolver al modo bot.',
  returnbotDone: (phone: string): string => `${phone} devuelto al modo bot.`,
} as const;
