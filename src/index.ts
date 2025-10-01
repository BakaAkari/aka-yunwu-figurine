import { Context, Schema, h, Session } from 'koishi'

export const name = 'aka-yunwu-figurine'

export const Config = Schema.object({
  apiKey: Schema.string().description('云雾API密钥').required(),
  apiTimeout: Schema.number().default(120).description('API请求超时时间（秒）'),
  pollInterval: Schema.number().default(3).description('轮询间隔时间（秒）'),
  maxPollAttempts: Schema.number().default(40).description('最大轮询次数'),
  
  // 默认设置
  defaultNumImages: Schema.number()
    .default(1)
    .min(1)
    .max(4)
    .description('默认生成图片数量')
})

export function apply(ctx: Context, config: any) {
  const logger = ctx.logger('aka-yunwu-figurine')
  const activeTasks = new Map<string, string>()  // userId -> requestId

  // 获取风格提示词（硬编码，不依赖配置）
  function getStylePrompt(style: string): string {
    const stylePrompts: Record<string, string> = {
      // 3个核心风格
      figurine: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
      realistic: '生成一个女孩cosplay这张插画的照片，背景设置在Comiket',
      character_design: '为我生成人物的角色设定（Character Design）, 比例设定（不同身高对比、头身比等）, 三视图（正面、侧面、背面）, 表情设定（Expression Sheet） , 动作设定（Pose Sheet） → 各种常见姿势, 服装设定（Costume Design）'
    }
    
    return stylePrompts[style] || stylePrompts.figurine
  }

  // 获取图片URL（三种方式）
  async function getImageUrl(img: any, session: Session): Promise<string | null> {
    let url: string | null = null
    
    // 方法1：从命令参数获取图片
    if (img) {
      url = img.attrs?.src || null
      if (url) {
        logger.debug('从命令参数获取图片', { url })
        return url
      }
    }
    
    // 方法2：从引用消息获取图片
    let elements = session.quote?.elements
    if (elements) {
      const images = h.select(elements, 'img')
      if (images.length > 0) {
        url = images[0].attrs.src
        logger.debug('从引用消息获取图片', { url })
        return url
      }
    }
    
    // 方法3：等待用户发送图片
    await session.send('请在30秒内发送一张图片')
    const msg = await session.prompt(30000)
    
    if (!msg) {
      await session.send('等待超时')
      return null
    }
    
    // 解析用户发送的消息
    elements = h.parse(msg)
    const images = h.select(elements, 'img')
    
    if (images.length === 0) {
      await session.send('未检测到图片，请重试')
      return null
    }
    
    url = images[0].attrs.src
    logger.debug('从用户输入获取图片', { url })
    return url
  }

  // 调用图像编辑API
  async function callImageEditAPI(prompt: string, imageUrl: string, numImages: number = 1) {
    const requestData = {
      prompt,
      image_urls: [imageUrl],  // ⚠️ 注意：必须是数组，即使只有一张图片
      num_images: numImages
    }
    
    logger.debug('调用图像编辑API', { prompt, imageUrls: [imageUrl], numImages })
    
    try {
      const response = await ctx.http.post(
        'https://yunwu.ai/fal-ai/nano-banana/edit',
        requestData,
        {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: config.apiTimeout * 1000
        }
      )
      
      logger.success('图像编辑API调用成功', { 
        requestId: response.request_id,
        status: response.status,
        queuePosition: response.queue_position
      })
      
      return response
    } catch (error) {
      logger.error('图像编辑API调用失败', error)
      throw error
    }
  }

  // 获取任务结果
  async function getTaskResult(requestId: string) {
    try {
      const response = await ctx.http.get(
        `https://yunwu.ai/fal-ai/nano-banana/requests/${requestId}`,
        {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
          },
          timeout: config.apiTimeout * 1000
        }
      )
      
      return response
    } catch (error) {
      logger.error('查询任务结果失败', { requestId, error })
      throw error
    }
  }

  // 通用图像处理函数
  async function processImage(session: any, img: any, style: string, numImages?: number) {
    const userId = session.userId
    
    // 检查是否已有任务进行
    if (activeTasks.has(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }
    
    // 获取参数
    const prompt = getStylePrompt(style)
    const imageCount = numImages || config.defaultNumImages
    
    // 验证参数
    if (imageCount < 1 || imageCount > 4) {
      return '生成数量必须在 1-4 之间'
    }
    
    // 获取图片URL
    const imageUrl = await getImageUrl(img, session)
    if (!imageUrl) {
      return  // 错误信息已在 getImageUrl 中发送
    }
    
    logger.info('开始图像处理', { 
      userId, 
      imageUrl, 
      style,
      prompt, 
      numImages: imageCount 
    })
    
    // 调用图像编辑API
    await session.send(`开始处理图片（${style}风格）...`)
    
    try {
      const taskResponse = await callImageEditAPI(prompt, imageUrl, imageCount)
      activeTasks.set(userId, taskResponse.request_id)
      
      await session.send(
        `图像处理任务已提交！\n风格: ${style}\n任务ID: ${taskResponse.request_id}\n队列位置: ${taskResponse.queue_position}`
      )
      
      // 开始轮询任务状态
      const channelId = session.channelId
      if (!channelId) {
        activeTasks.delete(userId)
        return '无法获取频道信息'
      }
      
      pollImageEditStatus(
        taskResponse.request_id, 
        userId, 
        session.bot, 
        channelId
      ).finally(() => {
        activeTasks.delete(userId)
      })
      
    } catch (error) {
      activeTasks.delete(userId)
      logger.error('图像处理失败', { userId, error })
      return '图像处理失败，请重试'
    }
  }

  // 轮询图像编辑任务状态（使用bot主动发送）
  async function pollImageEditStatus(
    requestId: string, 
    userId: string, 
    bot: any, 
    channelId: string
  ) {
    let attempts = 0
    
    logger.info('开始轮询图像编辑任务状态', { requestId, userId, channelId })
    
    while (attempts < config.maxPollAttempts) {
      try {
        logger.debug('轮询任务状态', { 
          requestId, 
          attempt: attempts + 1, 
          maxAttempts: config.maxPollAttempts 
        })
        
        const result = await getTaskResult(requestId)
        
        if (result.images && result.images.length > 0) {
          // 任务完成
          logger.success('图像编辑任务完成', { 
            requestId, 
            userId, 
            imageCount: result.images.length,
            images: result.images.map((img: any) => ({
              url: img.url,
              width: img.width,
              height: img.height,
              contentType: img.content_type
            }))
          })
          
          // 使用bot对象主动发送消息（推荐，避免session失效）
          try {
            await bot.sendMessage(channelId, '图像处理完成！')
            
            // 发送多张图片时添加延时，避免刷屏
            for (let i = 0; i < result.images.length; i++) {
              const img = result.images[i]
              await bot.sendMessage(channelId, h.image(img.url))
              
              // 如果有多张图片，添加延时
              if (result.images.length > 1 && i < result.images.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }
          } catch (sendError) {
            logger.error('发送结果消息失败', { requestId, userId, error: sendError })
          }
          
          return
        }
        
        // 继续等待
        logger.debug('任务未完成，继续等待', { requestId, waitTime: config.pollInterval })
        await new Promise(resolve => setTimeout(resolve, config.pollInterval * 1000))
        attempts++
        
      } catch (error) {
        logger.error('轮询任务失败', { requestId, attempt: attempts + 1, error })
        await new Promise(resolve => setTimeout(resolve, config.pollInterval * 1000))
        attempts++
      }
    }
    
    // 超时处理
    logger.warn('图像编辑任务轮询超时', { 
      requestId, 
      userId, 
      maxAttempts: config.maxPollAttempts 
    })
    
    // 使用bot对象发送超时消息
    try {
      await bot.sendMessage(channelId, '图像处理超时，请重试')
    } catch (error) {
      logger.error('发送超时消息失败', { requestId, userId, error })
    }
  }

  // 变手办风格命令
  ctx.command('变手办 [img:text]', '转换为手办风格')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      return processImage(session, img, 'figurine', options?.num)
    })
  
  // 变真人风格命令
  ctx.command('变真人 [img:text]', '转换为真人风格')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      return processImage(session, img, 'realistic', options?.num)
    })
  
  // 角色设定风格命令
  ctx.command('角色设定 [img:text]', '生成人物角色设定')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      return processImage(session, img, 'character_design', options?.num)
    })
  

  // 任务状态查询命令
  ctx.command('图像处理.状态', '查询当前图像处理任务状态')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      const userId = session.userId
      const taskId = activeTasks.get(userId)
      
      if (!taskId) {
        return '当前没有图像处理任务'
      }
      
      return `图像处理任务进行中...\n任务ID: ${taskId}`
    })

  logger.info('云雾图像处理插件已启动')
}
