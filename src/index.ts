import { Context, Schema, h, Session } from 'koishi'

export const name = 'aka-yunwu-figurine'

export interface StyleConfig {
  commandName: string
  commandDescription: string
  prompt: string
  enabled: boolean
}

export const Config = Schema.intersect([
  Schema.object({
    apiKey: Schema.string().description('云雾API密钥').required(),
    modelId: Schema.string().default('gemini-2.5-flash-image').description('图像生成模型ID'),
    apiTimeout: Schema.number().default(120).description('API请求超时时间（秒）'),
    commandTimeout: Schema.number().default(180).description('命令执行总超时时间（秒）'),
    
    // 默认设置
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .description('默认生成图片数量')
  }),
  
  // 自定义风格命令配置
  Schema.object({
    styles: Schema.array(Schema.object({
      commandName: Schema.string().required().description('命令名称（不含前缀斜杠）'),
      commandDescription: Schema.string().required().description('命令描述'),
      prompt: Schema.string().role('textarea', { rows: 4 }).required().description('生成 prompt'),
      enabled: Schema.boolean().default(true).description('是否启用此命令')
    })).role('table').default([
      {
        commandName: '变手办',
        commandDescription: '转换为手办风格',
        prompt: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
        enabled: true
      },
      {
        commandName: '变真人',
        commandDescription: '转换为真人风格',
        prompt: '生成一个亚洲真人女孩cosplay这张插画的写实照片，照片背景设置在普通街道',
        enabled: true
      },
      {
        commandName: '角色设定',
        commandDescription: '生成人物角色设定',
        prompt: '为我生成人物的角色设定（Character Design）, 比例设定（不同身高对比、头身比等）, 三视图（正面、侧面、背面）, 表情设定（Expression Sheet） , 动作设定（Pose Sheet） → 各种常见姿势, 服装设定（Costume Design）',
        enabled: true
      },
      {
        commandName: '道具设定',
        commandDescription: '生成游戏道具设定（武器、载具等）',
        prompt: '为我生成游戏道具的完整设定（Prop/Item Design），包含以下内容：功能结构图（Functional Components）、状态变化展示（State Variations）、细节特写（Detail Close-ups）',
        enabled: true
      },
      {
        commandName: '二次元',
        commandDescription: '转换为新海诚风格',
        prompt: '将这张图片变成新海诚风格, 日式赛璐珞的图片',
        enabled: true
      }
    ]).description('自定义风格命令配置')
  })
])

export function apply(ctx: Context, config: any) {
  const logger = ctx.logger('aka-yunwu-figurine')
  const activeTasks = new Map<string, string>()  // userId -> requestId

  // 下载图片并转换为 Base64
  async function downloadImageAsBase64(url: string): Promise<{ data: string, mimeType: string }> {
    try {
      const response = await ctx.http.get(url, { 
        responseType: 'arraybuffer',
        timeout: config.apiTimeout * 1000
      })
      
      const buffer = Buffer.from(response)
      const base64 = buffer.toString('base64')
      
      // 检测 MIME 类型
      let mimeType = 'image/jpeg'
      if (url.toLowerCase().endsWith('.png')) {
        mimeType = 'image/png'
      } else if (url.toLowerCase().endsWith('.webp')) {
        mimeType = 'image/webp'
      } else if (url.toLowerCase().endsWith('.gif')) {
        mimeType = 'image/gif'
      }
      
      logger.debug('图片下载并转换为Base64', { url, mimeType, size: base64.length })
      return { data: base64, mimeType }
    } catch (error) {
      logger.error('下载图片失败', { url, error })
      throw new Error('下载图片失败，请检查图片链接是否有效')
    }
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

  // 调用 Gemini 图像编辑 API
  async function callGeminiImageEdit(prompt: string, imageUrls: string | string[], numImages: number = 1) {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    
    logger.debug('开始下载图片并转换为Base64', { urls })
    
    // 下载所有图片并转换为 Base64
    const imageParts = []
    for (const url of urls) {
      const { data, mimeType } = await downloadImageAsBase64(url)
      imageParts.push({
        inline_data: {
          mime_type: mimeType,
          data: data
        }
      })
    }
    
    // 构建 Gemini API 请求体
    const requestData = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...imageParts
          ]
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE"]
      }
    }
    
    logger.debug('调用 Gemini 图像编辑 API', { prompt, imageCount: urls.length, numImages })
    
    try {
      const response = await ctx.http.post(
        `https://yunwu.ai/v1beta/models/${config.modelId}:generateContent`,
        requestData,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          params: {
            key: config.apiKey
          },
          timeout: config.apiTimeout * 1000
        }
      )
      
      logger.success('Gemini 图像编辑 API 调用成功', { response })
      return response
    } catch (error: any) {
      logger.error('Gemini 图像编辑 API 调用失败', { 
        message: error?.message || '未知错误',
        code: error?.code,
        status: error?.response?.status
      })
      // 不要直接抛出原始错误，避免泄露API密钥
      throw new Error('图像处理API调用失败')
    }
  }

  // 解析 Gemini 响应，提取图片 URL
  function parseGeminiResponse(response: any): string[] {
    try {
      const images: string[] = []
      
      if (response.candidates && response.candidates.length > 0) {
        for (const candidate of response.candidates) {
          if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
              // 检查是否有 inlineData（Base64 图片，驼峰命名）
              if (part.inlineData && part.inlineData.data) {
                const base64Data = part.inlineData.data
                const mimeType = part.inlineData.mimeType || 'image/jpeg'
                const dataUrl = `data:${mimeType};base64,${base64Data}`
                images.push(dataUrl)
              }
              // 兼容下划线命名
              else if (part.inline_data && part.inline_data.data) {
                const base64Data = part.inline_data.data
                const mimeType = part.inline_data.mime_type || 'image/jpeg'
                const dataUrl = `data:${mimeType};base64,${base64Data}`
                images.push(dataUrl)
              }
              // 检查是否有 fileData（文件引用）
              else if (part.fileData && part.fileData.fileUri) {
                images.push(part.fileData.fileUri)
              }
            }
          }
        }
      }
      
      return images
    } catch (error) {
      logger.error('解析 Gemini 响应失败', error)
      return []
    }
  }

  // 带超时的通用图像处理函数
  async function processImageWithTimeout(session: any, img: any, prompt: string, styleName: string, numImages?: number) {
    return Promise.race([
      processImage(session, img, prompt, styleName, numImages),
      new Promise<string>((_, reject) => 
        setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
      )
    ]).catch(error => {
      const userId = session.userId
      if (userId) activeTasks.delete(userId)
      logger.error('图像处理超时或失败', { userId, error })
      return error.message === '命令执行超时' ? '图像处理超时，请重试' : '图像处理失败，请稍后重试'
    })
  }

  // 通用图像处理函数
  async function processImage(session: any, img: any, prompt: string, styleName: string, numImages?: number) {
    const userId = session.userId
    
    // 检查是否已有任务进行
    if (activeTasks.has(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }
    
    // 获取参数
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
      styleName,
      prompt, 
      numImages: imageCount 
    })
    
    // 调用图像编辑API
    await session.send(`开始处理图片（${styleName}）...`)
    
    try {
      activeTasks.set(userId, 'processing')
      
      const response = await callGeminiImageEdit(prompt, imageUrl, imageCount)
      const images = parseGeminiResponse(response)
      
      if (images.length === 0) {
        activeTasks.delete(userId)
        return '图像处理失败：未能生成图片'
      }
      
      await session.send('图像处理完成！')
      
      // 发送生成的图片
      for (let i = 0; i < images.length; i++) {
        await session.send(h.image(images[i]))
        
        // 多张图片添加延时
        if (images.length > 1 && i < images.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      
      activeTasks.delete(userId)
      
    } catch (error) {
      activeTasks.delete(userId)
      logger.error('图像处理失败', { userId, error })
      
      // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
      return '图像处理失败，请稍后重试'
    }
  }


  // 动态注册风格命令
  if (config.styles && Array.isArray(config.styles)) {
    for (const style of config.styles) {
      if (style.enabled && style.commandName && style.prompt) {
        ctx.command(`${style.commandName} [img:text]`, style.commandDescription || '图像风格转换')
          .option('num', '-n <num:number> 生成图片数量 (1-4)')
          .action(async ({ session, options }, img) => {
            if (!session?.userId) return '会话无效'
            return processImageWithTimeout(session, img, style.prompt, style.commandName, options?.num)
          })
        
        logger.info(`已注册命令: ${style.commandName}`)
      }
    }
  }
  
  // 生成图像命令（自定义prompt）
  ctx.command('生成图像', '使用自定义prompt进行图像处理')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'
      
      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'
          
          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }
          
          // 等待用户发送图片和prompt
          await session.send('请发送图片和prompt，支持两种方式：\n1. 同时发送：[图片] + prompt描述\n2. 分步发送：先发送图片，再发送prompt文字\n\n例如：[图片] 让这张图片变成油画风格')
          
          const collectedImages: string[] = []
          let prompt = ''
          
          // 循环接收消息，直到收到纯文字消息作为 prompt
          while (true) {
            const msg = await session.prompt(60000) // 60秒超时
            if (!msg) {
              return '等待超时，请重试'
            }
            
            const elements = h.parse(msg)
            const images = h.select(elements, 'img')
            const textElements = h.select(elements, 'text')
            const text = textElements.map(el => el.attrs.content).join(' ').trim()
            
            // 如果有图片，收集图片
            if (images.length > 0) {
              for (const img of images) {
                collectedImages.push(img.attrs.src)
              }
              
              // 如果同时有文字，作为 prompt 并结束
              if (text) {
                prompt = text
                break
              }
              
              // 只有图片，继续等待
              await session.send(`已收到 ${collectedImages.length} 张图片，请继续发送图片或发送 prompt 文字`)
              continue
            }
            
            // 如果只有文字
            if (text) {
              if (collectedImages.length === 0) {
                return '未检测到图片，请先发送图片'
              }
              prompt = text
              break
            }
            
            // 既没有图片也没有文字
            return '未检测到有效内容，请重新发送'
          }
          
          // 验证
          if (collectedImages.length === 0) {
            return '未检测到图片，请重新发送'
          }
          
          if (!prompt) {
            return '未检测到prompt描述，请重新发送'
          }
          
          const imageUrl = collectedImages[0]
          const imageCount = options?.num || config.defaultNumImages
          
          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
          }
          
          logger.info('开始自定义图像处理', { 
            userId, 
            imageUrl, 
            prompt, 
            numImages: imageCount 
          })
          
          // 调用图像编辑API
          await session.send(`开始处理图片（自定义prompt）...\nPrompt: ${prompt}`)
          
          try {
            activeTasks.set(userId, 'processing')
            
            const response = await callGeminiImageEdit(prompt, imageUrl, imageCount)
            const resultImages = parseGeminiResponse(response)
            
            if (resultImages.length === 0) {
              activeTasks.delete(userId)
              return '图像处理失败：未能生成图片'
            }
            
            await session.send('图像处理完成！')
            
            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              await session.send(h.image(resultImages[i]))
              
              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }
            
            activeTasks.delete(userId)
            
          } catch (error) {
            activeTasks.delete(userId)
            logger.error('自定义图像处理失败', { userId, error })
            
            // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
            return '图像处理失败，请稍后重试'
          }
        })(),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
        )
      ]).catch(error => {
        const userId = session.userId
        if (userId) activeTasks.delete(userId)
        logger.error('自定义图像处理超时或失败', { userId, error })
        return error.message === '命令执行超时' ? '图像处理超时，请重试' : '图像处理失败，请稍后重试'
      })
    })

  // 合并命令（多张图片合并）
  ctx.command('合并', '合并多张图片，使用自定义prompt控制合并效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'
      
      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'
          
          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }
          
          // 等待用户发送多张图片和prompt
          await session.send('请发送多张图片和prompt，支持两种方式：\n1. 同时发送：[图片1] [图片2]... + prompt描述\n2. 分步发送：先发送多张图片，再发送prompt文字\n\n例如：[图片1] [图片2] 将这两张图片合并成一张')
          
          const collectedImages: string[] = []
          let prompt = ''
          
          // 循环接收消息，直到收到纯文字消息作为 prompt
          while (true) {
            const msg = await session.prompt(60000) // 60秒超时
            if (!msg) {
              return '等待超时，请重试'
            }
            
            const elements = h.parse(msg)
            const images = h.select(elements, 'img')
            const textElements = h.select(elements, 'text')
            const text = textElements.map(el => el.attrs.content).join(' ').trim()
            
            // 如果有图片，收集图片
            if (images.length > 0) {
              for (const img of images) {
                collectedImages.push(img.attrs.src)
              }
              
              // 如果同时有文字，作为 prompt 并结束
              if (text) {
                prompt = text
                break
              }
              
              // 只有图片，继续等待
              await session.send(`已收到 ${collectedImages.length} 张图片，请继续发送图片或发送 prompt 文字`)
              continue
            }
            
            // 如果只有文字
            if (text) {
              if (collectedImages.length < 2) {
                return `需要至少两张图片进行合并，当前只有 ${collectedImages.length} 张图片`
              }
              prompt = text
              break
            }
            
            // 既没有图片也没有文字
            return '未检测到有效内容，请重新发送'
          }
          
          // 验证
          if (collectedImages.length < 2) {
            return '需要至少两张图片进行合并，请重新发送'
          }
          
          if (!prompt) {
            return '未检测到prompt描述，请重新发送'
          }
          
          const imageCount = options?.num || config.defaultNumImages
          
          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
          }
          
          logger.info('开始图片合并处理', { 
            userId, 
            imageUrls: collectedImages, 
            prompt, 
            numImages: imageCount,
            imageCount: collectedImages.length
          })
          
          // 调用图像编辑API（支持多张图片）
          await session.send(`开始合并图片（${collectedImages.length}张）...\nPrompt: ${prompt}`)
          
          try {
            activeTasks.set(userId, 'processing')
            
            const response = await callGeminiImageEdit(prompt, collectedImages, imageCount)
            const resultImages = parseGeminiResponse(response)
            
            if (resultImages.length === 0) {
              activeTasks.delete(userId)
              return '图片合并失败：未能生成图片'
            }
            
            await session.send('图片合并完成！')
            
            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              await session.send(h.image(resultImages[i]))
              
              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }
            
            activeTasks.delete(userId)
            
          } catch (error) {
            activeTasks.delete(userId)
            logger.error('图片合并失败', { userId, error })
            
            // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
            return '图片合并失败，请稍后重试'
          }
        })(),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
        )
      ]).catch(error => {
        const userId = session.userId
        if (userId) activeTasks.delete(userId)
        logger.error('图片合并超时或失败', { userId, error })
        return error.message === '命令执行超时' ? '图片合并超时，请重试' : '图片合并失败，请稍后重试'
      })
    })

  // 任务状态查询命令
  ctx.command('图像处理.状态', '查询当前图像处理任务状态')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      const userId = session.userId
      const taskStatus = activeTasks.get(userId)
      
      if (!taskStatus) {
        return '当前没有图像处理任务'
      }
      
      return `图像处理任务进行中...`
    })

  logger.info('云雾图像处理插件已启动 (Gemini 2.5 Flash Image)')
}
