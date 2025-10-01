import { Context, Schema, h } from 'koishi'

export const name = 'aka-yunwu-figurine'

export interface Config {
  apiKey: string
  cooldownTime: number
  apiTimeout: number
  pollInterval: number
  maxPollAttempts: number
  enableLog: boolean
  maxImageSize: number
  figurinePresets: string[]
  defaultStyle: number
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required().description('云雾API密钥'),
  cooldownTime: Schema.number().default(30).min(5).max(300).description('等待发送图片的时间(秒)'),
  apiTimeout: Schema.number().default(120).min(30).max(600).description('API请求超时时间(秒)'),
  pollInterval: Schema.number().default(3).min(1).max(10).description('轮询间隔时间(秒)'),
  maxPollAttempts: Schema.number().default(40).min(10).max(100).description('最大轮询次数'),
  enableLog: Schema.boolean().default(true).description('启用日志记录'),
  maxImageSize: Schema.number().default(10).min(1).max(50).description('最大图片大小限制(MB)'),
  figurinePresets: Schema.array(Schema.string()).default([
    'figurine, anime figure, detailed, high quality, professional photography, studio lighting',
    'chibi figurine, cute, kawaii style, pastel colors, soft lighting, collectible',
    'realistic figurine, premium quality, museum display, dramatic lighting, detailed craftsmanship',
    'fantasy figurine, magical, mystical atmosphere, ethereal lighting, enchanted'
  ]).description('手办化风格预设文本'),
  defaultStyle: Schema.number().default(1).min(1).max(4).description('默认手办化风格(1-4)')
})

// 云雾API响应接口 - 根据文档定义
interface YunwuApiResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  request_id: string
  response_url?: string
  status_url: string
  cancel_url: string
  logs: any
  metrics: any
  queue_position: number
}

// 任务结果接口 - 根据文档定义
interface TaskResult {
  seed: number
  images: Array<{
    url: string
    width: number
    height: number
    content_type: string
  }>
  prompt: string
  request: any
  timings: any
  has_nsfw_concepts: boolean[]
}

// 任务状态管理
interface TaskInfo {
  requestId: string
  userId: string
  session: any
  prompt: string
  numImages: number
  startTime: number
  pollCount: number
  style: number
  originalImageUrl?: string
}

// 等待图片状态
interface WaitingImage {
  style: number
  timeout: NodeJS.Timeout
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-yunwu-figurine')
  const processingUsers: Set<string> = new Set()
  const activeTasks: Map<string, TaskInfo> = new Map()
  const waitingImages: Map<string, WaitingImage> = new Map()

  logger.info('========================================')
  logger.info('手办化插件: 开始初始化')
  logger.info('配置信息:', {
    hasApiKey: !!config.apiKey,
    apiKeyLength: config.apiKey?.length || 0,
    cooldownTime: config.cooldownTime,
    defaultStyle: config.defaultStyle,
    presetsCount: config.figurinePresets?.length || 0
  })

  // 验证API密钥配置
  if (!config.apiKey || config.apiKey.trim() === '') {
    logger.error('API密钥未配置或为空')
    return
  }

  // 日志函数
  function logInfo(message: string, data?: any) {
    if (config.enableLog && logger) {
      logger.info(message, data)
    }
  }

  function logError(message: string, error?: any) {
    if (config.enableLog && logger) {
      logger.error(message, error)
    }
  }

  // 提取图片
  function extractImages(session: any): string[] {
    const images: string[] = []
    
    let elements = session.quote?.elements || session.elements
    
    if (elements) {
      const imgElements = h.select(elements, 'img')
      
      for (const img of imgElements) {
        const imageUrl = img.attrs?.src
        if (imageUrl) {
          images.push(imageUrl)
          logInfo('提取到图片', { 
            url: imageUrl.substring(0, 100),
            source: session.quote?.elements ? 'quote' : 'session'
          })
        }
      }
    }
    
    return images
  }

  // 提交手办化任务 - 根据云雾API文档
  async function submitFigurineTask(prompt: string, numImages: number = 1): Promise<YunwuApiResponse> {
    logInfo('提交手办化任务', { 
      prompt: prompt.substring(0, 100), 
      numImages
    })
    
    const response = await ctx.http.post('https://yunwu.ai/fal-ai/nano-banana', {
      prompt: prompt,
      num_images: numImages
    }, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: config.apiTimeout * 1000
    }) as YunwuApiResponse

    logInfo('任务提交成功', { 
      status: response.status, 
      requestId: response.request_id,
      queuePosition: response.queue_position
    })

    return response
  }

  // 查询任务状态 - 根据云雾API文档
  async function queryTaskStatus(requestId: string): Promise<TaskResult | null> {
    try {
      logInfo('查询任务状态', { requestId })
      
      // 使用 auto 作为 model_name，根据文档说明
      const response = await ctx.http.get(`https://yunwu.ai/fal-ai/auto/requests/${requestId}`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`
        },
        timeout: 10000
      }) as TaskResult

      logInfo('查询成功', { 
        requestId,
        hasImages: response.images?.length > 0,
        imageCount: response.images?.length || 0
      })

      return response
    } catch (error: any) {
      logError('查询失败', { requestId, error: error?.message })
      return null
    }
  }

  // 轮询任务状态
  async function pollTaskStatus(taskInfo: TaskInfo): Promise<void> {
    const { requestId, userId, session } = taskInfo
    
    try {
      const result = await queryTaskStatus(requestId)
      
      if (!result) {
        taskInfo.pollCount++
        if (taskInfo.pollCount >= config.maxPollAttempts) {
          logError('轮询超时', { requestId, pollCount: taskInfo.pollCount })
          await session.send('生成超时，请稍后重试')
          processingUsers.delete(userId)
          activeTasks.delete(requestId)
          return
        }
        
        setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
        return
      }

      // 检查是否有生成的图片
      if (result.images && result.images.length > 0) {
        logInfo('生成成功', { 
          requestId, 
          imageCount: result.images.length,
          style: taskInfo.style
        })

        // 发送生成的图片
        for (const image of result.images) {
          await session.send(h.image(image.url))
        }

        await session.send(`✅ 手办化完成！\n🎨 风格: ${taskInfo.style}\n🖼️ 图片数量: ${result.images.length}`)
        
        processingUsers.delete(userId)
        activeTasks.delete(requestId)
        return
      }

      // 继续轮询
      taskInfo.pollCount++
      if (taskInfo.pollCount >= config.maxPollAttempts) {
        await session.send('生成超时，请稍后重试')
        processingUsers.delete(userId)
        activeTasks.delete(requestId)
        return
      }

      // 显示进度
      if (taskInfo.pollCount % 5 === 0) {
        const elapsedTime = Math.floor((Date.now() - taskInfo.startTime) / 1000)
        await session.send(`⏳ 正在生成中... (已等待 ${elapsedTime} 秒)`)
      }

      setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
      
    } catch (error: any) {
      logError('轮询失败', { requestId, error: error?.message })
      await session.send('生成过程出现错误，请稍后重试')
      processingUsers.delete(userId)
      activeTasks.delete(requestId)
    }
  }

  // 构建手办化提示词
  function buildFigurinePrompt(style: number, imageUrl?: string): string {
    const preset = config.figurinePresets[style - 1] || config.figurinePresets[0]
    
    if (imageUrl) {
      return `Transform this image into a high-quality figurine: ${imageUrl}, ${preset}`
    } else {
      return preset
    }
  }

  // 处理手办化
  async function processImage(session: any, imageUrl: string, style: number): Promise<void> {
    const userId = session.userId
    
    try {
      logInfo('开始处理', { userId, style, imageUrl: imageUrl.substring(0, 100) })
      
      await session.send('🎨 正在生成手办化图片，请稍候...')
      
      const prompt = buildFigurinePrompt(style, imageUrl)
      const response = await submitFigurineTask(prompt, 1)
      
      if (!response.request_id) {
        await session.send('❌ 任务提交失败，请稍后重试')
        processingUsers.delete(userId)
        return
      }

      const taskInfo: TaskInfo = {
        requestId: response.request_id,
        userId: userId,
        session: session,
        prompt: prompt,
        numImages: 1,
        startTime: Date.now(),
        pollCount: 0,
        style: style,
        originalImageUrl: imageUrl
      }

      activeTasks.set(response.request_id, taskInfo)
      
      if (response.queue_position > 0) {
        await session.send(`📋 任务已提交，队列位置: ${response.queue_position}`)
      }

      setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
      
    } catch (error: any) {
      logError('处理失败', { error: error?.message, userId })
      await session.send('处理失败，请稍后重试')
      processingUsers.delete(userId)
    }
  }

  // 等待图片
  async function waitForImage(session: any, style: number): Promise<string> {
    const userId = session.userId
    
    if (waitingImages.has(userId)) {
      const { timeout } = waitingImages.get(userId)!
      clearTimeout(timeout)
    }
    
    const timeoutMs = config.cooldownTime * 1000
    const timeout = setTimeout(() => {
      waitingImages.delete(userId)
      processingUsers.delete(userId)
      session.send('等待超时，请重新发送指令')
    }, timeoutMs)
    
    waitingImages.set(userId, { style, timeout })
    
    return `请发送一张图片，我将使用风格${style}进行手办化处理（${config.cooldownTime}秒内有效）`
  }

  // 注册命令
  logger.info('开始注册命令')
  
  // 检查是否有已存在的命令并记录详细信息
  const commander = (ctx as any).$commander
  if (commander) {
    const existingCmd = commander._commands?.get('手办化')
    if (existingCmd) {
      logger.warn('检测到已存在的"手办化"命令', {
        cmdName: existingCmd.name,
        hasAlias: existingCmd._aliases?.size > 0,
        aliases: existingCmd._aliases ? Array.from(existingCmd._aliases) : [],
        optionNames: existingCmd._options ? Array.from(existingCmd._options.keys()) : []
      })
    }
  }

  // 手办化命令 - 使用长选项名避免冲突
  ctx.command('手办化 [image:text]', '通过图片生成手办化效果')
    .option('style', '--风格 <style:number>', { fallback: config.defaultStyle })
    .action(async ({ session, options }) => {
      const userId = session?.userId
      if (!userId || !session) {
        return '参数错误'
      }

      const style = Number((options as any)?.style) || config.defaultStyle
      
      if (style < 1 || style > config.figurinePresets.length) {
        return `风格参数必须在1-${config.figurinePresets.length}之间`
      }

      if (processingUsers.has(userId)) {
        return '正在处理中，请等待当前任务完成'
      }
      
      processingUsers.add(userId)
      
      try {
        const images = extractImages(session)
        if (images.length > 0) {
          await processImage(session, images[0], style)
        } else {
          return await waitForImage(session, style)
        }
      } catch (error) {
        logError('命令执行失败', error)
        processingUsers.delete(userId)
        return '处理失败，请稍后重试'
      }
    })

  logger.info('"手办化"命令注册完成')

  // 文生图命令
  ctx.command('文生图 <prompt:text>', '使用AI生成图片')
    .option('num', '--数量 <num:number>', { fallback: 1 })
    .action(async ({ session, options }, prompt) => {
      const userId = session?.userId
      if (!userId || !session) {
        return '参数错误'
      }

      if (!prompt || prompt.length < 2) {
        return '请输入图片描述（至少2个字符）'
      }

      const numImages = Number((options as any)?.num) || 1
      
      if (numImages < 1 || numImages > 4) {
        return '图片数量必须在1-4之间'
      }

      if (processingUsers.has(userId)) {
        return '正在生成中，请等待当前任务完成'
      }

      processingUsers.add(userId)

      try {
        const fullPrompt = buildFigurinePrompt(config.defaultStyle) + ', ' + prompt
        const response = await submitFigurineTask(fullPrompt, numImages)
        
        if (!response.request_id) {
          await session.send('❌ 任务提交失败')
          processingUsers.delete(userId)
          return
        }

        const taskInfo: TaskInfo = {
          requestId: response.request_id,
          userId: userId,
          session: session,
          prompt: fullPrompt,
          numImages: numImages,
          startTime: Date.now(),
          pollCount: 0,
          style: config.defaultStyle
        }

        activeTasks.set(response.request_id, taskInfo)
        setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
        
        await session.send('🎨 正在生成图片，请稍候...')
        if (response.queue_position > 0) {
          await session.send(`📋 队列位置: ${response.queue_position}`)
        }
      } catch (error) {
        logError('文生图失败', error)
        processingUsers.delete(userId)
        return '生成失败，请稍后重试'
      }
    })

  logger.info('"文生图"命令注册完成')

  // 重置命令
  ctx.command('手办化重置', '重置处理状态')
    .action(async ({ session }) => {
      const userId = session?.userId
      if (!userId) return '无法获取用户信息'
      
      const wasProcessing = processingUsers.has(userId)
      
      processingUsers.delete(userId)
      
      for (const [requestId, taskInfo] of activeTasks) {
        if (taskInfo.userId === userId) {
          activeTasks.delete(requestId)
        }
      }
      
      if (waitingImages.has(userId)) {
        const { timeout } = waitingImages.get(userId)!
        clearTimeout(timeout)
        waitingImages.delete(userId)
      }
      
      return wasProcessing ? '已重置处理状态' : '当前没有处理中的任务'
    })

  // 状态查询命令
  ctx.command('手办化状态', '查询任务状态')
    .action(async ({ session }) => {
      const userId = session?.userId
      if (!userId) return '无法获取用户信息'
      
      const userTasks = Array.from(activeTasks.values()).filter(task => task.userId === userId)
      const isWaiting = waitingImages.has(userId)
      
      if (userTasks.length === 0 && !isWaiting) {
        return '当前没有进行中的任务'
      }

      let statusMessage = `📋 当前任务状态:\n`
      
      if (isWaiting) {
        const { style } = waitingImages.get(userId)!
        statusMessage += `\n⏳ 等待图片输入 (风格${style})\n`
      }
      
      for (const task of userTasks) {
        const elapsedTime = Math.floor((Date.now() - task.startTime) / 1000)
        statusMessage += `\n🆔 任务: ${task.requestId.substring(0, 8)}...\n`
        statusMessage += `🎨 风格: ${task.style}\n`
        statusMessage += `⏱️ 已等待: ${elapsedTime}秒\n`
      }
      
      return statusMessage
    })

  logger.info('所有命令注册完成')

  // 监听消息事件
  ctx.on('message', async (session) => {
    if (session.userId && waitingImages.has(session.userId)) {
      const images = extractImages(session)
      if (images.length > 0) {
        const { style, timeout } = waitingImages.get(session.userId)!
        clearTimeout(timeout)
        waitingImages.delete(session.userId)
        
        try {
          await processImage(session, images[0], style)
        } catch (error) {
          logError('处理等待图片失败', error)
          await session.send('处理失败，请稍后重试')
          processingUsers.delete(session.userId)
        }
      }
    }
  })

  // 插件卸载
  ctx.on('dispose', () => {
    for (const [userId, { timeout }] of waitingImages) {
      clearTimeout(timeout)
    }
    waitingImages.clear()
    processingUsers.clear()
    activeTasks.clear()
    logger.info('插件已卸载，资源已清理')
  })

  logger.info('插件初始化完成')
  logger.info('========================================')
}
