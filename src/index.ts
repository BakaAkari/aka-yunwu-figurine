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

// 云雾API响应接口
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

// 任务结果接口
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

  // 验证API密钥配置
  if (!config.apiKey || config.apiKey.trim() === '') {
    logger.error('云雾文生图模块: API密钥未配置或为空')
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

  // 提取图片 - 参考aka-xxapi-figurine的实现
  function extractImages(session: any): string[] {
    const images: string[] = []
    
    // 优先从session.quote?.elements获取图片
    let elements = session.quote?.elements
    if (!elements) {
      // 如果没有quote，则从session.elements获取
      elements = session.elements
    }
    
    if (elements) {
      const imgElements = h.select(elements, 'img')
      
      for (const img of imgElements) {
        // 使用img.attrs.src获取图片直链
        const imageUrl = img.attrs?.src
        if (imageUrl) {
          images.push(imageUrl)
          logInfo('手办化模块: 从img.attrs.src提取到图片直链', { 
            extractedUrl: imageUrl.substring(0, 100),
            urlLength: imageUrl.length,
            fileName: img.attrs?.file || 'unknown',
            fileSize: img.attrs?.fileSize || 'unknown',
            subType: img.attrs?.subType || 'unknown',
            source: session.quote?.elements ? 'quote' : 'session'
          })
        }
      }
    }
    
    logInfo('手办化模块: 图片提取结果', { 
      totalImages: images.length,
      hasQuote: !!session.quote?.elements,
      hasElements: !!session.elements,
      elementsCount: elements?.length || 0
    })
    
    return images
  }

  // 检测图片大小和格式
  async function checkImageSize(imageUrl: string): Promise<{ size: number, isValid: boolean, contentType?: string }> {
    try {
      // 发送HEAD请求获取图片信息
      const response = await ctx.http.head(imageUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })
      
      const contentLength = parseInt((response as any).headers?.['content-length'] || '0')
      const contentType = (response as any).headers?.['content-type'] || ''
      const sizeInMB = contentLength / (1024 * 1024)
      
      // 检查图片格式
      const isValidFormat = contentType.startsWith('image/jpeg') || 
                           contentType.startsWith('image/jpg') || 
                           contentType.startsWith('image/png')
      
      const isValidSize = sizeInMB <= config.maxImageSize && sizeInMB > 0.01 // 至少10KB
      const isValid = isValidFormat && isValidSize
      
      logInfo('手办化模块: 图片检测', {
        url: imageUrl.substring(0, 100) + '...',
        sizeInMB: sizeInMB.toFixed(2),
        contentType: contentType,
        maxSize: config.maxImageSize,
        isValidFormat: isValidFormat,
        isValidSize: isValidSize,
        isValid: isValid
      })
      
      return { size: sizeInMB, isValid, contentType }
    } catch (error: any) {
      logError('手办化模块: 图片检测失败', {
        url: imageUrl.substring(0, 100) + '...',
        error: error?.message
      })
      // 检测失败时允许继续处理
      return { size: 0, isValid: true }
    }
  }

  // 处理图片URL
  async function processImageUrl(imageUrl: string): Promise<string> {
    try {
      // 直接使用图片URL，QQ图片的src已经是公网可访问的直链
      if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        logInfo('手办化模块: 使用图片直链', { 
          url: imageUrl.substring(0, 100) + '...',
          isQQImage: imageUrl.includes('gchat.qpic.cn') || imageUrl.includes('multimedia.nt.qq.com.cn'),
          domain: new URL(imageUrl).hostname
        })
        return imageUrl
      }
      
      // 不支持base64格式
      if (imageUrl.startsWith('data:image/')) {
        logError('手办化模块: API不支持base64格式', { 
          imageType: imageUrl.substring(5, imageUrl.indexOf(';')),
          dataLength: imageUrl.length 
        })
        throw new Error('API不支持base64格式，请发送图片而不是粘贴图片')
      }
      
      logError('手办化模块: 不支持的图片格式', { imageUrl: imageUrl.substring(0, 100) })
      throw new Error('不支持的图片格式，请发送图片而不是链接')
      
    } catch (error) {
      logError('手办化模块: 图片处理失败', error)
      throw error
    }
  }

  // 等待图片
  async function waitForImage(session: any, style: number): Promise<string> {
    const userId = session.userId
    
    // 清除之前的等待状态
    if (waitingImages.has(userId)) {
      const { timeout } = waitingImages.get(userId)!
      clearTimeout(timeout)
    }
    
    // 设置超时时间
    const timeoutMs = config.cooldownTime * 1000
    const timeout = setTimeout(() => {
      waitingImages.delete(userId)
      processingUsers.delete(userId)
      session.send('等待超时，请重新发送指令')
    }, timeoutMs)
    
    waitingImages.set(userId, { style, timeout })
    
    return `请发送一张图片，我将使用风格${style}进行手办化处理（${config.cooldownTime}秒内有效）`
  }

  // 构建手办化提示词
  function buildFigurinePrompt(originalImageUrl: string, style: number): string {
    const preset = config.figurinePresets[style - 1] || config.figurinePresets[0]
    
    // 基于原始图片生成手办化提示词
    const basePrompt = `Transform this image into a high-quality figurine: ${originalImageUrl}`
    const fullPrompt = `${basePrompt}, ${preset}`
    
    logInfo('手办化模块: 构建提示词', {
      style,
      preset: preset.substring(0, 50) + '...',
      fullPrompt: fullPrompt.substring(0, 100) + '...',
      originalImageUrl: originalImageUrl.substring(0, 100) + '...'
    })
    
    return fullPrompt
  }

  // 提交手办化任务
  async function submitFigurineTask(imageUrl: string, style: number, numImages: number = 1): Promise<YunwuApiResponse> {
    const prompt = buildFigurinePrompt(imageUrl, style)
    
    logInfo('手办化模块: 提交手办化任务', { 
      prompt: prompt.substring(0, 100), 
      numImages, 
      style,
      imageUrl: imageUrl.substring(0, 100) + '...'
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

    logInfo('手办化模块: 任务提交响应', { 
      status: response.status, 
      requestId: response.request_id,
      queuePosition: response.queue_position,
      style
    })

    return response
  }

  // 查询任务状态
  async function queryTaskStatus(requestId: string): Promise<TaskResult | null> {
    try {
      logInfo('手办化模块: 查询任务状态', { requestId })
      
      const response = await ctx.http.get(`https://yunwu.ai/fal-ai/auto/requests/${requestId}`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`
        },
        timeout: 10000
      }) as TaskResult

      logInfo('手办化模块: 任务状态查询成功', { 
        requestId,
        hasImages: response.images?.length > 0,
        imageCount: response.images?.length || 0
      })

      return response
    } catch (error: any) {
      logError('手办化模块: 查询任务状态失败', { requestId, error: error?.message })
      return null
    }
  }

  // 轮询任务状态
  async function pollTaskStatus(taskInfo: TaskInfo): Promise<void> {
    const { requestId, userId, session, prompt } = taskInfo
    
    try {
      const result = await queryTaskStatus(requestId)
      
      if (!result) {
        // 查询失败，增加轮询次数
        taskInfo.pollCount++
        if (taskInfo.pollCount >= config.maxPollAttempts) {
          logError('手办化模块: 轮询超时', { requestId, pollCount: taskInfo.pollCount })
          await session.send('手办化生成超时，请稍后重试')
          processingUsers.delete(userId)
          activeTasks.delete(requestId)
          return
        }
        
        // 继续轮询
        setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
        return
      }

      // 检查是否有生成的图片
      if (result.images && result.images.length > 0) {
        logInfo('手办化模块: 生成成功', { 
          requestId, 
          imageCount: result.images.length,
          style: taskInfo.style,
          prompt: prompt.substring(0, 50)
        })

        // 发送生成的图片
        for (const image of result.images) {
          const imageMessage = h.image(image.url)
          await session.send(imageMessage)
        }

        // 发送生成信息
        await session.send(`✅ 手办化完成！\n🎨 风格: ${taskInfo.style}\n🖼️ 图片数量: ${result.images.length}`)
        
        // 清理状态
        processingUsers.delete(userId)
        activeTasks.delete(requestId)
        return
      }

      // 没有结果，继续轮询
      taskInfo.pollCount++
      if (taskInfo.pollCount >= config.maxPollAttempts) {
        logError('手办化模块: 轮询次数超限', { requestId, pollCount: taskInfo.pollCount })
        await session.send('手办化生成超时，请稍后重试')
        processingUsers.delete(userId)
        activeTasks.delete(requestId)
        return
      }

      // 显示进度信息
      if (taskInfo.pollCount % 5 === 0) {
        const elapsedTime = Math.floor((Date.now() - taskInfo.startTime) / 1000)
        await session.send(`⏳ 正在手办化生成中... (已等待 ${elapsedTime} 秒，风格${taskInfo.style})`)
      }

      // 继续轮询
      setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
      
    } catch (error: any) {
      logError('手办化模块: 轮询任务失败', { requestId, error: error?.message })
      await session.send('手办化过程中出现错误，请稍后重试')
      processingUsers.delete(userId)
      activeTasks.delete(requestId)
    }
  }

  // 处理手办化图片
  async function processImage(session: any, imageUrl: string, style: number): Promise<void> {
    const userId = session.userId
    let processedUrl: string | undefined
    
    try {
      logInfo(`手办化模块: 开始处理图片，风格${style}`, { imageUrl: imageUrl.substring(0, 100) + '...', userId })
      
      // 发送处理中消息
      await session.send('🎨 正在生成手办化图片，请稍候...')
      
      // 处理图片URL
      processedUrl = await processImageUrl(imageUrl)
      logInfo('手办化模块: 图片URL处理完成', { 
        original: imageUrl.substring(0, 50) + '...',
        processed: processedUrl.substring(0, 50) + '...'
      })
      
      // 验证API密钥
      if (!config.apiKey || config.apiKey.trim() === '') {
        logError('手办化模块: API密钥为空，无法调用API')
        await session.send('手办化失败: API密钥未配置')
        processingUsers.delete(userId)
        return
      }

      // 提交手办化任务
      const response = await submitFigurineTask(processedUrl, style, 1)
      
      if (!response.request_id) {
        logError('手办化模块: 任务提交失败，未返回request_id')
        await session.send('❌ 手办化任务提交失败，请稍后重试')
        processingUsers.delete(userId)
        return
      }

      // 创建任务信息
      const taskInfo: TaskInfo = {
        requestId: response.request_id,
        userId: userId,
        session: session,
        prompt: buildFigurinePrompt(processedUrl, style),
        numImages: 1,
        startTime: Date.now(),
        pollCount: 0,
        style: style,
        originalImageUrl: processedUrl
      }

      // 保存任务信息并开始轮询
      activeTasks.set(response.request_id, taskInfo)
      
      logInfo('手办化模块: 任务已提交，开始轮询', { 
        requestId: response.request_id,
        status: response.status,
        queuePosition: response.queue_position,
        style
      })

      // 显示队列位置信息
      if (response.queue_position > 0) {
        await session.send(`📋 手办化任务已提交，当前队列位置: ${response.queue_position}`)
      }

      // 开始轮询
      setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
      
    } catch (error: any) {
      let errorMessage = '手办化处理失败，请稍后重试'
      
      // 根据错误类型提供更具体的提示
      if (error?.message?.includes('request timeout') || error?.code === 'ETIMEDOUT') {
        errorMessage = '处理超时，图片可能过大或网络较慢，请尝试使用较小的图片'
      } else if (error?.message?.includes('图片过大')) {
        errorMessage = error.message
      } else if (error?.message?.includes('API不支持')) {
        errorMessage = error.message
      } else if (error?.message?.includes('不支持的图片格式')) {
        errorMessage = error.message
      }
      
      logError('手办化模块: 处理图片失败', {
        error: error,
        errorMessage: error?.message || '未知错误',
        errorStack: error?.stack,
        userId: userId,
        style: style,
        imageUrl: imageUrl.substring(0, 100) + '...',
        processedUrl: processedUrl?.substring(0, 100) + '...' || '未处理'
      })
      
      await session.send(errorMessage)
      // 处理失败时立即清除处理状态
      processingUsers.delete(userId)
    }
  }

  // 手办化命令
  ctx.command('手办化', '通过图片生成手办化效果')
    .option('style', '-s <style:number>', { fallback: config.defaultStyle })
    .action(async (argv) => {
      const userId = argv.session?.userId
      const style = Number(argv.options?.style) || config.defaultStyle
      
      // 验证风格参数
      if (style < 1 || style > config.figurinePresets.length) {
        return `风格参数必须在1-${config.figurinePresets.length}之间`
      }

      // 检查用户是否正在处理中
      if (!userId || !argv.session) {
        return '参数错误，请检查命令格式'
      }

      if (processingUsers.has(userId)) {
        return '手办化正在处理中，请等待当前任务完成后再试'
      }
      
      // 立即标记用户为处理中状态，防止重复调用
      processingUsers.add(userId)
      
      try {
        logInfo(`手办化模块: 用户请求手办化风格${style}`, { userId })
        
        // 检查消息中是否有图片
        const images = extractImages(argv.session)
        if (images.length > 0) {
          // 直接处理第一张图片
          await processImage(argv.session, images[0], style)
        } else {
          // 没有图片，等待用户发送图片
          const waitMessage = await waitForImage(argv.session, style)
          return waitMessage
        }
      } catch (error) {
        logError('手办化模块错误', error)
        // 处理失败时也要清除处理状态
        processingUsers.delete(userId)
        return '手办化处理失败，请稍后重试'
      }
    })

  // 文生图命令（保留作为备用）
  ctx.command('文生图', '使用AI生成图片')
    .option('num', '-n <num:number>', { fallback: 1 })
    .action(async (argv) => {
      const userId = argv.session?.userId
      const prompt = argv.session?.content?.trim()
      const numImages = Number(argv.options?.num) || 1
      
      // 验证提示词
      if (!prompt || prompt.length < 2) {
        return '请输入要生成的图片描述（至少2个字符）'
      }

      if (prompt.length > 500) {
        return '提示词过长，请控制在500字符以内'
      }

      // 验证图片数量
      if (numImages < 1 || numImages > 4) {
        return '图片数量必须在1-4之间'
      }

      // 检查用户是否正在处理中
      if (!userId || !prompt || !argv.session) {
        return '参数错误，请检查命令格式'
      }

      if (processingUsers.has(userId)) {
        return '正在生成图片中，请等待当前任务完成'
      }

      // 标记用户为处理中状态
      processingUsers.add(userId)

      try {
        // 使用默认风格进行文生图
        const response = await submitFigurineTask(prompt, config.defaultStyle, numImages)
        if (!response.request_id) {
          await argv.session.send('❌ 任务提交失败，请稍后重试')
          processingUsers.delete(userId)
          return
        }

        // 创建任务信息
        const taskInfo: TaskInfo = {
          requestId: response.request_id,
          userId: userId,
          session: argv.session,
          prompt: prompt,
          numImages: numImages,
          startTime: Date.now(),
          pollCount: 0,
          style: config.defaultStyle
        }

        // 保存任务信息并开始轮询
        activeTasks.set(response.request_id, taskInfo)
        setTimeout(() => pollTaskStatus(taskInfo), config.pollInterval * 1000)
        
        await argv.session.send('🎨 正在生成图片，请稍候...')
        if (response.queue_position > 0) {
          await argv.session.send(`📋 任务已提交，当前队列位置: ${response.queue_position}`)
        }
      } catch (error) {
        logError('文生图模块: 命令执行失败', error)
        processingUsers.delete(userId)
        return '生成失败，请稍后重试'
      }
    })

  // 重置状态命令
  ctx.command('手办化重置', '重置手办化处理状态')
    .action(async (argv) => {
      const userId = argv.session?.userId
      const wasProcessing = userId ? processingUsers.has(userId) : false
      
      // 清除处理状态
      if (userId) {
        processingUsers.delete(userId)
        
        // 清除该用户的所有任务
        for (const [requestId, taskInfo] of activeTasks) {
          if (taskInfo.userId === userId) {
            activeTasks.delete(requestId)
          }
        }
        
        // 清除等待状态
        if (waitingImages.has(userId)) {
          const { timeout } = waitingImages.get(userId)!
          clearTimeout(timeout)
          waitingImages.delete(userId)
        }
      }
      
      logInfo('手办化模块: 手动重置用户状态', { userId, wasProcessing })
      
      return wasProcessing ? '已重置处理状态，可以重新使用手办化指令' : '当前没有处理中的任务'
    })

  // 查询任务状态命令
  ctx.command('手办化状态', '查询当前用户的手办化任务状态')
    .action(async (argv) => {
      const userId = argv.session?.userId
      if (!userId) {
        return '无法获取用户信息'
      }
      const userTasks = Array.from(activeTasks.values()).filter(task => task.userId === userId)
      const isWaiting = waitingImages.has(userId)
      
      if (userTasks.length === 0 && !isWaiting) {
        return '当前没有进行中的手办化任务'
      }

      let statusMessage = `📋 当前任务状态 (${userTasks.length}个):\n`
      
      if (isWaiting) {
        const { style } = waitingImages.get(userId)!
        statusMessage += `\n⏳ 等待图片输入 (风格${style})\n`
      }
      
      for (const task of userTasks) {
        const elapsedTime = Math.floor((Date.now() - task.startTime) / 1000)
        statusMessage += `\n🆔 任务ID: ${task.requestId.substring(0, 8)}...\n`
        statusMessage += `🎨 风格: ${task.style}\n`
        statusMessage += `⏱️ 已等待: ${elapsedTime}秒\n`
        statusMessage += `🔄 轮询次数: ${task.pollCount}\n`
      }
      
      return statusMessage
    })

  // 文生图状态命令（保留作为备用）
  ctx.command('文生图状态', '查询当前用户的文生图任务状态')
    .action(async (argv) => {
      const userId = argv.session?.userId
      if (!userId) {
        return '无法获取用户信息'
      }
      const userTasks = Array.from(activeTasks.values()).filter(task => task.userId === userId)
      
      if (userTasks.length === 0) {
        return '当前没有进行中的文生图任务'
      }

      let statusMessage = `📋 当前任务状态 (${userTasks.length}个):\n`
      for (const task of userTasks) {
        const elapsedTime = Math.floor((Date.now() - task.startTime) / 1000)
        statusMessage += `\n🆔 任务ID: ${task.requestId.substring(0, 8)}...\n`
        statusMessage += `📝 提示词: ${task.prompt.substring(0, 30)}...\n`
        statusMessage += `⏱️ 已等待: ${elapsedTime}秒\n`
        statusMessage += `🔄 轮询次数: ${task.pollCount}\n`
      }
      
      return statusMessage
    })

  // 监听消息事件，处理等待中的图片
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
          logError('手办化模块: 处理等待的图片失败', error)
          await session.send('手办化处理失败，请稍后重试')
          // 处理失败时也要清除处理状态
          processingUsers.delete(session.userId)
        }
      }
    }
  })

  // 插件卸载时清理资源
  ctx.on('dispose', () => {
    // 清理所有等待中的超时器
    for (const [userId, { timeout }] of waitingImages) {
      clearTimeout(timeout)
    }
    waitingImages.clear()
    // 清理处理状态
    processingUsers.clear()
    activeTasks.clear()
    logInfo('手办化模块: 插件已卸载，资源已清理')
  })
}
