import * as Sentry from '@sentry/react'
import {
  AIProviderNoImplementedPaintError,
  ApiError,
  BaseError,
  ChatboxAIAPIError,
  NetworkError,
} from '@shared/models/errors'
import { createMessage, type Message } from '@shared/types'
import { countMessageWords } from '@shared/utils/message'
import { createModel } from '@/adapters'
import { getLogger } from '@/lib/utils'
import { runCompactionWithUIState } from '@/packages/context-management'
import { getModelDisplayName } from '@/packages/model-setting-utils'
import { estimateTokensFromMessages } from '@/packages/token'
import platform from '@/platform'
import { SESSION_ATTACHMENT_RAG_LOG_PREFIX } from '../../../shared/session-attachment-rag/logging'
import * as chatStore from '../chatStore'
import { ensureMessageFileSessionAttachment } from '../sessionAttachmentRagIndexing'
import * as settingActions from '../settingActions'
import { settingsStore } from '../settingsStore'
import { getSessionWebBrowsing } from './utils'
import { cancelAllScheduled } from './scheduler'

const log = getLogger('session-messages')

async function attachLargeFileRagMetadata(sessionId: string, message: Message): Promise<Message> {
  if (platform.type !== 'desktop' || !message.files?.length) {
    return message
  }

  let changed = false
  const files = await Promise.all(
    message.files.map(async (file) => {
      if (file.ragMode !== 'session-retrieval' || !file.storageKey) {
        return file
      }

      const nextFile = await ensureMessageFileSessionAttachment({
        sessionId,
        messageId: message.id,
        file,
      })
      changed =
        changed ||
        nextFile.sessionAttachmentId !== file.sessionAttachmentId ||
        nextFile.sessionAttachmentAvailability !== file.sessionAttachmentAvailability ||
        nextFile.sessionAttachmentIndexStatus !== file.sessionAttachmentIndexStatus ||
        nextFile.sessionAttachmentStatus !== file.sessionAttachmentStatus ||
        nextFile.sessionAttachmentChunkCount !== file.sessionAttachmentChunkCount ||
        nextFile.sessionAttachmentTotalChunks !== file.sessionAttachmentTotalChunks ||
        nextFile.sessionAttachmentEmbeddedChunks !== file.sessionAttachmentEmbeddedChunks ||
        nextFile.sessionAttachmentIndexingStage !== file.sessionAttachmentIndexingStage
      return nextFile
    })
  )

  if (!changed) {
    return message
  }

  const updatedMessage = { ...message, files }
  log.debug(
    `${SESSION_ATTACHMENT_RAG_LOG_PREFIX} Attachment metadata attached to message: session=${sessionId}, message=${message.id}`
  )
  await chatStore.updateMessage(sessionId, message.id, updatedMessage)
  return updatedMessage
}

export async function insertMessage(sessionId: string, msg: Message) {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }
  msg.wordCount = countMessageWords(msg)
  msg.tokenCount = estimateTokensFromMessages([msg])
  return await chatStore.insertMessage(session.id, msg)
}

export async function insertMessageAfter(sessionId: string, msg: Message, afterMsgId: string) {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }
  msg.wordCount = countMessageWords(msg)
  msg.tokenCount = estimateTokensFromMessages([msg])
  await chatStore.insertMessage(sessionId, msg, afterMsgId)
}

export async function modifyMessage(
  sessionId: string,
  updated: Message,
  refreshCounting?: boolean,
  updateOnlyCache?: boolean
) {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }
  if (refreshCounting) {
    updated.wordCount = countMessageWords(updated)
    updated.tokenCount = estimateTokensFromMessages([updated])
    updated.tokenCountMap = undefined
  }
  updated.timestamp = Date.now()
  if (updateOnlyCache) {
    await chatStore.updateMessageCache(sessionId, updated.id, updated)
  } else {
    await chatStore.updateMessage(sessionId, updated.id, updated)
  }
}

export function updateStreamingCache(sessionId: string, message: Message): void {
  message.timestamp = Date.now()
  chatStore.updateMessageCache(sessionId, message.id, message).catch((err) => {
    console.error('Failed to update streaming cache:', err)
  })
}

export async function persistStreamingMessage(
  sessionId: string,
  message: Message,
  options?: { refreshCounting?: boolean }
): Promise<void> {
  if (options?.refreshCounting) {
    message.wordCount = countMessageWords(message)
    message.tokenCount = estimateTokensFromMessages([message])
    message.tokenCountMap = undefined
  }
  message.timestamp = Date.now()
  await chatStore.updateMessage(sessionId, message.id, message)
}

export async function removeMessage(sessionId: string, messageId: string) {
  if (platform.type === 'desktop') {
    try {
      await platform.getSessionAttachmentRagController().deleteMessageAttachments(messageId)
    } catch (error) {
      console.warn('Failed to cleanup session attachment RAG entries for message deletion:', error)
    }
  }
  await chatStore.removeMessage(sessionId, messageId)
}

export async function submitNewUserMessage(
  sessionId: string,
  params: { newUserMsg: Message; needGenerating: boolean; onUserMessageReady?: () => void }
) {
  cancelAllScheduled(sessionId)

  const { generate } = await import('../sessionActions.js')

  const session = await chatStore.getSession(sessionId)
  const settings = await chatStore.getSessionSettings(sessionId)
  if (!session || !settings) {
    return
  }

  if (session.type === 'chat' || session.type === undefined) {
    const compactionResult = await runCompactionWithUIState(sessionId)
    if (!compactionResult.success) {
      throw compactionResult.error ?? new Error('Compaction failed')
    }
  }

  params.onUserMessageReady?.()

  let { newUserMsg } = params
  const { needGenerating } = params

  // Добавляем временную метку к сообщению пользователя (UTC)
  const now = new Date().toISOString()
  if (newUserMsg.contentParts && newUserMsg.contentParts.length > 0) {
    const textPart = newUserMsg.contentParts.find(p => p.type === 'text')
    if (textPart) {
      textPart.text = `${textPart.text} (${now})`
    }
  } else {
    newUserMsg.contentParts = [{ type: 'text', text: `(${now})` }]
  }

  await insertMessage(sessionId, newUserMsg)
  newUserMsg = await attachLargeFileRagMetadata(sessionId, newUserMsg)

  const globalSettings = settingsStore.getState().getSettings()
  const isPro = settingActions.isPro()
  const remoteConfig = await settingActions.getRemoteConfig()

  let newAssistantMsg = createMessage('assistant', '')
  if (newUserMsg.files && newUserMsg.files.length > 0) {
    if (!newAssistantMsg.status) {
      newAssistantMsg.status = []
    }
    newAssistantMsg.status.push({
      type: 'sending_file',
      mode: isPro ? 'advanced' : 'local',
    })
  }
  if (newUserMsg.links && newUserMsg.links.length > 0) {
    if (!newAssistantMsg.status) {
      newAssistantMsg.status = []
    }
    newAssistantMsg.status.push({
      type: 'loading_webpage',
      mode: isPro ? 'advanced' : 'local',
    })
  }
  if (needGenerating) {
    newAssistantMsg.generating = true
    await insertMessage(sessionId, newAssistantMsg)
  }

  try {
    const model = await createModel(settings)
    if (getSessionWebBrowsing(sessionId, settings.provider) && platform.type === 'web' && !model.isSupportToolUse()) {
      if (remoteConfig.setting_chatboxai_first) {
        throw ChatboxAIAPIError.fromCodeName('model_not_support_web_browsing', 'model_not_support_web_browsing')
      } else {
        throw ChatboxAIAPIError.fromCodeName('model_not_support_web_browsing_2', 'model_not_support_web_browsing_2')
      }
    }
  } catch (err: unknown) {
    const error = !(err instanceof Error) ? new Error(`${err}`) : err
    if (
      !(
        error instanceof ApiError ||
        error instanceof NetworkError ||
        error instanceof AIProviderNoImplementedPaintError
      )
    ) {
      Sentry.captureException(error)
    }
    let errorCode: number | undefined
    if (err instanceof BaseError) {
      errorCode = err.code
    }
    newAssistantMsg = {
      ...newAssistantMsg,
      generating: false,
      cancel: undefined,
      model: await getModelDisplayName(settings, globalSettings, 'chat'),
      contentParts: [{ type: 'text', text: '' }],
      errorCode,
      error: `${error.message}`,
      status: [],
    }
    if (needGenerating) {
      await modifyMessage(sessionId, newAssistantMsg)
    } else {
      await insertMessage(sessionId, newAssistantMsg)
    }
    return
  }

  if (needGenerating) {
    return generate(sessionId, newAssistantMsg, { operationType: 'send_message' })
  }
}
