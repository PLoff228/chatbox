import type { ScheduledMessage } from '@shared/types/session'
import { insertMessage } from './messages'
import { chatStore } from '../chatStore'
import { generate } from '../sessionActions'

const timers: Record<string, NodeJS.Timeout[]> = {}

export function parseScheduledMessages(text: string): {
  immediateText: string | null
  scheduled: { text: string; sendAt: Date }[]
} {
  const scheduled: { text: string; sendAt: Date }[] = []
  const regex = /〚([^〛]*)〛【([^】]*)】/g
  let match
  const parts: { text: string; time: string | null }[] = []

  while ((match = regex.exec(text)) !== null) {
    parts.push({ text: match[1], time: match[2] })
  }

  if (parts.length === 0) {
    return { immediateText: text, scheduled: [] }
  }

  const first = parts[0]
  if (first.time) {
    // Ответ на сигнал: все блоки с временем → только запланированные
    for (const p of parts) {
      if (p.time) {
        const sendAt = new Date(p.time)
        if (!isNaN(sendAt.getTime())) {
          scheduled.push({ text: p.text, sendAt })
        }
      }
    }
    return { immediateText: null, scheduled }
  } else {
    // Обычный ответ: первый блок без времени → немедленный
    const immediateText = first.text
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]
      if (p.time) {
        const sendAt = new Date(p.time)
        if (!isNaN(sendAt.getTime())) {
          scheduled.push({ text: p.text, sendAt })
        }
      }
    }
    return { immediateText, scheduled }
  }
}

export function cancelAllScheduled(sessionId: string) {
  if (timers[sessionId]) {
    timers[sessionId].forEach((timer) => clearTimeout(timer))
    delete timers[sessionId]
  }
}

async function sendSignal(sessionId: string, sentAt: Date) {
  const signalMsg = {
    id: `signal_${Date.now()}`,
    role: 'user' as const,
    contentParts: [{ type: 'text', text: `(${sentAt.toISOString()})` }],
    generating: false,
  }
  await insertMessage(sessionId, signalMsg)
  await generate(sessionId, signalMsg, { operationType: 'send_message' })
}

export function scheduleMessages(
  sessionId: string,
  parentMessageId: string,
  scheduledMessages: ScheduledMessage[]
) {
  if (!scheduledMessages || scheduledMessages.length === 0) return

  cancelAllScheduled(sessionId)

  const timersForSession: NodeJS.Timeout[] = []

  for (const sm of scheduledMessages) {
    const sendAt = new Date(sm.sendAt)
    const now = new Date()
    const delay = Math.max(0, sendAt.getTime() - now.getTime())

    const timer = setTimeout(async () => {
      const newMsg = {
        id: `scheduled_${Date.now()}_${Math.random()}`,
        role: 'assistant' as const,
        contentParts: [{ type: 'text', text: sm.text }],
        generating: false,
      }
      await insertMessage(sessionId, newMsg)
      await sendSignal(sessionId, sendAt)
    }, delay)

    timersForSession.push(timer)
  }

  timers[sessionId] = timersForSession
}
