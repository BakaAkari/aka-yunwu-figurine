import { Context, Schema, h, Session } from 'koishi'
import { readFileSync, writeFileSync, existsSync, mkdirSync, promises as fs } from 'fs'
import { join } from 'path'

export const name = 'aka-yunwu-figurine'

export interface StyleConfig {
  commandName: string
  commandDescription: string
  prompt: string
  enabled: boolean
}

// 用户数据接口
export interface UserData {
  userId: string
  userName: string
  totalUsageCount: number
  dailyUsageCount: number
  lastDailyReset: string
  purchasedCount: number           // 历史累计充值次数
  remainingPurchasedCount: number // 当前剩余充值次数
  donationCount: number
  donationAmount: number
  lastUsed: string
  createdAt: string
}

// 用户数据存储接口
export interface UsersData {
  [userId: string]: UserData
}

// 插件配置接口
export interface PluginConfig {
  apiKey: string
  modelId: string
  apiTimeout: number
  commandTimeout: number
  defaultNumImages: number
  dailyFreeLimit: number
  rateLimitWindow: number
  rateLimitMax: number
  adminUsers: string[]
  styles: StyleConfig[]
}

// 充值记录接口
export interface RechargeRecord {
  id: string
  timestamp: string
  type: 'single' | 'batch'
  operator: {
    userId: string
    userName: string
  }
  targets: Array<{
    userId: string
    userName: string
    amount: number
    beforeBalance: number
    afterBalance: number
  }>
  totalAmount: number
  note: string
  metadata: Record<string, any>
}

// 充值历史数据接口
export interface RechargeHistory {
  version: string
  lastUpdate: string
  records: RechargeRecord[]
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
      .description('默认生成图片数量'),
    
    // 配额设置
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .description('每日免费调用次数'),
    
    // 限流设置
    rateLimitWindow: Schema.number()
      .default(300)
      .min(60)
      .max(3600)
      .description('限流时间窗口（秒）'),
    rateLimitMax: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .description('限流窗口内最大调用次数'),
    
    // 管理员设置
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户ID列表（不受每日使用限制）')
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

export function apply(ctx: Context, config: PluginConfig) {
  const logger = ctx.logger('aka-yunwu-figurine')
  const activeTasks = new Map<string, string>()  // userId -> requestId
  const rateLimitMap = new Map<string, number[]>()  // userId -> timestamps
  
  // 获取动态风格指令
  function getStyleCommands() {
    if (!config.styles || !Array.isArray(config.styles)) return []
    return config.styles
      .filter(style => style.enabled && style.commandName && style.prompt)
      .map(style => ({
        name: style.commandName,
        description: style.commandDescription || '图像风格转换'
      }))
  }

  // 指令管理系统
  const commandRegistry = {
    // 非管理员指令（包含动态风格指令）
    userCommands: [
      ...getStyleCommands(),
      { name: '生成图像', description: '使用自定义prompt进行图像处理' },
      { name: '合成图片', description: '合成多张图片，使用自定义prompt控制合成效果' },
      { name: '图像状态', description: '查询当前图像处理任务状态' },
      { name: '图像管理员', description: '查询当前用户的管理员状态' },
      { name: '图像额度', description: '查询用户额度信息' }
    ],
    // 管理员指令
    adminCommands: [
      { name: '图像充值', description: '为用户充值次数（仅管理员）' },
      { name: '图像统计', description: '查看全局统计信息（仅管理员）' },
      { name: '图像充值记录', description: '查看充值历史记录（仅管理员）' },
      { name: '图像恢复备份', description: '从备份文件恢复数据（仅管理员）' }
    ]
  }
  
  // 数据文件路径
  const dataDir = './data/yunwu'
  const dataFile = join(dataDir, 'users_data.json')
  const backupFile = join(dataDir, 'users_data.json.backup')
  const rechargeHistoryFile = join(dataDir, 'recharge_history.json')
  
  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  // 检查用户每日调用限制
  async function checkDailyLimit(userId: string): Promise<{ allowed: boolean, message?: string, isAdmin?: boolean }> {
    // 检查是否为管理员
    if (config.adminUsers && config.adminUsers.includes(userId)) {
      return { allowed: true, isAdmin: true }
    }
    
    // 检查限流
    const now = Date.now()
    const userTimestamps = rateLimitMap.get(userId) || []
    const windowStart = now - config.rateLimitWindow * 1000
    
    // 清理过期的时间戳
    const validTimestamps = userTimestamps.filter(timestamp => timestamp > windowStart)
    
    if (validTimestamps.length >= config.rateLimitMax) {
      return {
        allowed: false,
        message: `操作过于频繁，请${Math.ceil((validTimestamps[0] + config.rateLimitWindow * 1000 - now) / 1000)}秒后再试`,
        isAdmin: false
      }
    }
    
    const usersData = await loadUsersData()
    const userData = usersData[userId]
    
    if (!userData) {
      return { allowed: true, isAdmin: false }
    }
    
    const today = new Date().toDateString()
    const lastReset = new Date(userData.lastDailyReset || userData.createdAt).toDateString()
    
    // 如果是新的一天，重置每日计数
    if (today !== lastReset) {
      userData.dailyUsageCount = 0
      userData.lastDailyReset = new Date().toISOString()
      await saveUsersData(usersData)
      return { allowed: true, isAdmin: false }
    }
    
    // 检查每日免费次数
    if (userData.dailyUsageCount < config.dailyFreeLimit) {
      return { allowed: true, isAdmin: false }
    }
    
    // 检查充值次数
    if (userData.remainingPurchasedCount > 0) {
      return { allowed: true, isAdmin: false }
    }
    
    return { 
      allowed: false, 
      message: `今日免费次数已用完（${config.dailyFreeLimit}次），充值次数也已用完。请联系管理员充值或明天再试`,
      isAdmin: false
    }
  }

  // 通用输入获取函数
  async function getPromptInput(session: Session, message: string): Promise<string | null> {
    await session.send(message)
    const input = await session.prompt(30000) // 30秒超时
    return input || null
  }


  // 异步读取用户数据
  async function loadUsersData(): Promise<UsersData> {
    try {
      if (existsSync(dataFile)) {
        const data = await fs.readFile(dataFile, 'utf-8')
        return JSON.parse(data)
      }
    } catch (error) {
      logger.error('读取用户数据失败', error)
      // 尝试从备份恢复
      if (existsSync(backupFile)) {
        try {
          const backupData = await fs.readFile(backupFile, 'utf-8')
          logger.warn('从备份文件恢复用户数据')
          return JSON.parse(backupData)
        } catch (backupError) {
          logger.error('备份文件也损坏，使用空数据', backupError)
        }
      }
    }
    return {}
  }

  // 异步保存用户数据（带备份）
  async function saveUsersData(data: UsersData): Promise<void> {
    try {
      // 如果原文件存在，先备份
      if (existsSync(dataFile)) {
        await fs.copyFile(dataFile, backupFile)
      }
      
      // 写入新数据
      await fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      logger.error('保存用户数据失败', error)
      throw error
    }
  }

  // 异步读取充值历史
  async function loadRechargeHistory(): Promise<RechargeHistory> {
    try {
      if (existsSync(rechargeHistoryFile)) {
        const data = await fs.readFile(rechargeHistoryFile, 'utf-8')
        return JSON.parse(data)
      }
    } catch (error) {
      logger.error('读取充值历史失败', error)
    }
    return {
      version: '1.0.0',
      lastUpdate: new Date().toISOString(),
      records: []
    }
  }

  // 异步保存充值历史
  async function saveRechargeHistory(history: RechargeHistory): Promise<void> {
    try {
      history.lastUpdate = new Date().toISOString()
      await fs.writeFile(rechargeHistoryFile, JSON.stringify(history, null, 2), 'utf-8')
    } catch (error) {
      logger.error('保存充值历史失败', error)
      throw error
    }
  }

  // 获取或创建用户数据
  async function getUserData(userId: string, userName: string): Promise<UserData> {
    const usersData = await loadUsersData()
    
    if (!usersData[userId]) {
      // 创建新用户数据
      usersData[userId] = {
        userId,
        userName,
        totalUsageCount: 0,
        dailyUsageCount: 0,
        lastDailyReset: new Date().toISOString(),
        purchasedCount: 0,
        remainingPurchasedCount: 0,
        donationCount: 0,
        donationAmount: 0,
        lastUsed: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
      await saveUsersData(usersData)
      logger.info('创建新用户数据', { userId, userName })
    }
    
    return usersData[userId]
  }

  // 更新用户数据（优先消耗免费次数）
  async function updateUserData(userId: string, userName: string, commandName: string): Promise<{ userData: UserData, consumptionType: 'free' | 'purchased' }> {
    const usersData = await loadUsersData()
    const now = new Date().toISOString()
    const today = new Date().toDateString()
    
    if (!usersData[userId]) {
      // 创建新用户数据，使用userId作为用户名
      usersData[userId] = {
        userId,
        userName: userId,
        totalUsageCount: 1,
        dailyUsageCount: 1,
        lastDailyReset: now,
        purchasedCount: 0,
        remainingPurchasedCount: 0,
        donationCount: 0,
        donationAmount: 0,
        lastUsed: now,
        createdAt: now
      }
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'free' }
    }
    
    // 更新现有用户数据
    // 不更新用户名，保持原有用户名
    usersData[userId].totalUsageCount += 1
    usersData[userId].lastUsed = now
    
    // 检查是否需要重置每日计数
    const lastReset = new Date(usersData[userId].lastDailyReset || usersData[userId].createdAt).toDateString()
    if (today !== lastReset) {
      usersData[userId].dailyUsageCount = 0
      usersData[userId].lastDailyReset = now
    }
    
    // 优先消耗每日免费次数
    if (usersData[userId].dailyUsageCount < config.dailyFreeLimit) {
      usersData[userId].dailyUsageCount += 1
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'free' }
    }
    
    // 消耗充值次数
    if (usersData[userId].remainingPurchasedCount > 0) {
      usersData[userId].remainingPurchasedCount -= 1
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'purchased' }
    }
    
    // 理论上不应该到达这里，因为checkDailyLimit已经检查过了
    await saveUsersData(usersData)
    return { userData: usersData[userId], consumptionType: 'free' }
  }

  // 记录用户调用次数并发送统计信息（仅在成功时调用）
  async function recordUserUsage(session: Session, commandName: string) {
    const userId = session.userId
    const userName = session.username || session.userId || '未知用户'
    
    if (!userId) return
    
    // 检查是否为管理员
    const isAdmin = config.adminUsers && config.adminUsers.includes(userId)
    
    // 更新限流记录
    const now = Date.now()
    const userTimestamps = rateLimitMap.get(userId) || []
    userTimestamps.push(now)
    rateLimitMap.set(userId, userTimestamps)
    
    // 更新用户数据
    const { userData, consumptionType } = await updateUserData(userId, userName, commandName)
    
    // 发送统计信息
    if (isAdmin) {
      await session.send(`📊 使用统计 [管理员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`)
    } else {
      const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
      const consumptionText = consumptionType === 'free' ? '每日免费次数' : '充值次数'
      await session.send(`📊 使用统计\n用户：${userData.userName}\n本次消费：${consumptionText} -1\n总调用次数：${userData.totalUsageCount}次\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次`)
    }
    
    logger.info('用户调用记录', { 
      userId, 
      userName: userData.userName, 
      commandName, 
      totalUsageCount: userData.totalUsageCount,
      dailyUsageCount: userData.dailyUsageCount,
      remainingPurchasedCount: userData.remainingPurchasedCount,
      consumptionType,
      isAdmin
    })
  }

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
        // 检查是否有多张图片
        if (images.length > 1) {
          await session.send('本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图片"命令')
          return null
        }
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
    
    // 检查是否有多张图片
    if (images.length > 1) {
      await session.send('本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图片"命令')
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
      
      // 成功处理图片后记录使用统计
      await recordUserUsage(session, styleName)
      
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
            
            // 检查每日调用限制
            const limitCheck = await checkDailyLimit(session.userId!)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }
            
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
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'
          
          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }
          
          // 等待用户发送图片和prompt
          await session.send('请发送一张图片和prompt，支持两种方式：\n1. 同时发送：[图片] + prompt描述\n2. 分步发送：先发送一张图片，再发送prompt文字\n\n例如：[图片] 让这张图片变成油画风格\n\n注意：本功能仅支持处理一张图片，多张图片请使用"合成图片"命令')
          
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
              // 检查是否已经有图片
              if (collectedImages.length > 0) {
                return '本功能仅支持处理一张图片，如需合成多张图片请使用"合成图片"命令'
              }
              
              // 检查是否发送了多张图片
              if (images.length > 1) {
                return '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图片"命令'
              }
              
              for (const img of images) {
                collectedImages.push(img.attrs.src)
              }
              
              // 如果同时有文字，作为 prompt 并结束
              if (text) {
                prompt = text
                break
              }
              
              // 只有图片，继续等待
              await session.send('已收到图片，请发送 prompt 描述文字')
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
          
          if (collectedImages.length > 1) {
            return '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图片"命令'
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
            
            // 成功处理图片后记录使用统计
            await recordUserUsage(session, '生成图像')
            
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

  // 合成图片命令（多张图片合成）
  ctx.command('合成图片', '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'
          
          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }
          
          // 等待用户发送多张图片和prompt
          await session.send('请发送多张图片和prompt，支持两种方式：\n1. 同时发送：[图片1] [图片2]... + prompt描述\n2. 分步发送：先发送多张图片，再发送prompt文字\n\n例如：[图片1] [图片2] 将这两张图片合成一张')
          
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
                return `需要至少两张图片进行合成，当前只有 ${collectedImages.length} 张图片`
              }
              prompt = text
              break
            }
            
            // 既没有图片也没有文字
            return '未检测到有效内容，请重新发送'
          }
          
          // 验证
          if (collectedImages.length < 2) {
            return '需要至少两张图片进行合成，请重新发送'
          }
          
          if (!prompt) {
            return '未检测到prompt描述，请重新发送'
          }
          
          const imageCount = options?.num || config.defaultNumImages
          
          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
          }
          
          logger.info('开始图片合成处理', { 
            userId, 
            imageUrls: collectedImages, 
            prompt, 
            numImages: imageCount,
            imageCount: collectedImages.length
          })
          
          // 调用图像编辑API（支持多张图片）
          await session.send(`开始合成图片（${collectedImages.length}张）...\nPrompt: ${prompt}`)
          
          try {
            activeTasks.set(userId, 'processing')
            
            const response = await callGeminiImageEdit(prompt, collectedImages, imageCount)
            const resultImages = parseGeminiResponse(response)
            
            if (resultImages.length === 0) {
              activeTasks.delete(userId)
              return '图片合成失败：未能生成图片'
            }
            
            await session.send('图片合成完成！')
            
            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              await session.send(h.image(resultImages[i]))
              
              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }
            
            // 成功处理图片后记录使用统计
            await recordUserUsage(session, '合成图片')
            
            activeTasks.delete(userId)
            
          } catch (error) {
            activeTasks.delete(userId)
            logger.error('图片合成失败', { userId, error })
            
            // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
            return '图片合成失败，请稍后重试'
          }
        })(),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
        )
      ]).catch(error => {
        const userId = session.userId
        if (userId) activeTasks.delete(userId)
        logger.error('图片合成超时或失败', { userId, error })
        return error.message === '命令执行超时' ? '图片合成超时，请重试' : '图片合成失败，请稍后重试'
      })
    })

  // 任务状态查询命令
  ctx.command('图像状态', '查询当前图像处理任务状态')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      const userId = session.userId
      const taskStatus = activeTasks.get(userId)
      
      if (!taskStatus) {
        return '当前没有图像处理任务'
      }
      
      return `图像处理任务进行中...`
    })

  // 管理员状态查询命令
  ctx.command('图像管理员', '查询当前用户的管理员状态')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      const userId = session.userId
      const userName = session.username || session.userId || '未知用户'
      const isAdmin = config.adminUsers && config.adminUsers.includes(userId)
      
      if (isAdmin) {
        return `🔑 管理员状态\n用户：${userName}\n状态：管理员\n权限：无限制使用所有功能`
      } else {
        // 获取用户数据
        const usersData = await loadUsersData()
        const userData = usersData[userId]
        
        if (!userData) {
          return `👤 普通用户\n用户：${userName}\n状态：普通用户\n今日剩余免费：${config.dailyFreeLimit}次\n充值剩余：0次`
        }
        
        const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
        return `👤 普通用户\n用户：${userName}\n状态：普通用户\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次\n总调用次数：${userData.totalUsageCount}次`
      }
    })

  // 充值管理命令
  ctx.command('图像充值 [content:text]', '为用户充值次数（仅管理员）')
    .action(async ({ session }, content) => {
      if (!session?.userId) return '会话无效'
      
      // 检查管理员权限
      if (!config.adminUsers.includes(session.userId)) {
        return '权限不足，仅管理员可操作'
      }
      
      // 获取要解析的内容
      const inputContent = content || await getPromptInput(session, '请输入充值信息，格式：\n@用户1 @用户2 充值次数 [备注]\n\n例如：\n@难捅一号 10 测试充值')
      if (!inputContent) return '输入超时或无效'
      
      // 解析输入内容
      const elements = h.parse(inputContent)
      const atElements = h.select(elements, 'at')
      const textElements = h.select(elements, 'text')
      const text = textElements.map(el => el.attrs.content).join(' ').trim()
      
      if (atElements.length === 0) {
        return '未找到@用户，请使用@用户的方式'
      }
      
      // 解析充值次数和备注
      const parts = text.split(/\s+/).filter(p => p)
      if (parts.length === 0) {
        return '请输入充值次数'
      }
      
      const amount = parseInt(parts[0])
      const note = parts.slice(1).join(' ') || '管理员充值'
      
      if (!amount || amount <= 0) {
        return '充值次数必须大于0'
      }
      
      const userIds = atElements.map(el => el.attrs.id).filter(Boolean)
      
      if (userIds.length === 0) {
        return '未找到有效的用户，请使用@用户的方式'
      }
      
      try {
        
        const usersData = await loadUsersData()
        const rechargeHistory = await loadRechargeHistory()
        const now = new Date().toISOString()
        const recordId = `recharge_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).substr(2, 3)}`
        
        const targets = []
        
        // 为每个用户充值
        for (const userId of userIds) {
          if (!userId) continue // 跳过无效的userId
          
          // 获取被充值用户的用户名，优先使用已存储的用户名，否则使用userId
          let userName = userId
          if (usersData[userId]) {
            userName = usersData[userId].userName || userId
          }
          
          if (!usersData[userId]) {
            // 创建新用户，使用userId作为初始用户名
            usersData[userId] = {
              userId,
              userName: userId,
              totalUsageCount: 0,
              dailyUsageCount: 0,
              lastDailyReset: now,
              purchasedCount: 0,
              remainingPurchasedCount: 0,
              donationCount: 0,
              donationAmount: 0,
              lastUsed: now,
              createdAt: now
            }
          }
          
          const beforeBalance = usersData[userId].remainingPurchasedCount
          usersData[userId].purchasedCount += amount
          usersData[userId].remainingPurchasedCount += amount
          // 不更新用户名，保持原有的用户名
          
          targets.push({
            userId,
            userName,
            amount,
            beforeBalance,
            afterBalance: usersData[userId].remainingPurchasedCount
          })
        }
        
        // 保存用户数据
        await saveUsersData(usersData)
        
        // 记录充值历史
        const record: RechargeRecord = {
          id: recordId,
          timestamp: now,
          type: userIds.length > 1 ? 'batch' : 'single',
          operator: {
            userId: session.userId,
            userName: session.username || session.userId
          },
          targets,
          totalAmount: amount * userIds.length,
          note: note || '管理员充值',
          metadata: {}
        }
        
        rechargeHistory.records.push(record)
        await saveRechargeHistory(rechargeHistory)
        
        const userList = targets.map(t => `${t.userName}(${t.afterBalance}次)`).join(', ')
        return `✅ 充值成功\n目标用户：${userList}\n充值次数：${amount}次/人\n总充值：${record.totalAmount}次\n操作员：${record.operator.userName}\n备注：${record.note}`
        
      } catch (error) {
        logger.error('充值操作失败', error)
        return '充值失败，请稍后重试'
      }
    })

  // 额度查询命令
  ctx.command('图像额度 [target:text]', '查询用户额度信息')
    .action(async ({ session }, target) => {
      if (!session?.userId) return '会话无效'
      
      const isAdmin = config.adminUsers.includes(session.userId)
      let targetUserId = session.userId
      let targetUserName = session.username || session.userId
      
      // 如果指定了目标用户且是管理员
      if (target && isAdmin) {
        const userMatch = target.match(/<at id="([^"]+)"/)
        if (userMatch) {
          targetUserId = userMatch[1]
          targetUserName = '目标用户'
        }
      } else if (target && !isAdmin) {
        return '权限不足，仅管理员可查询其他用户'
      }
      
      try {
        const usersData = await loadUsersData()
        const userData = usersData[targetUserId]
        
        if (!userData) {
          return `👤 用户信息\n用户：${targetUserName}\n状态：新用户\n今日剩余免费：${config.dailyFreeLimit}次\n充值剩余：0次`
        }
        
        const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
        const totalAvailable = remainingToday + userData.remainingPurchasedCount
        
        return `👤 用户额度信息\n用户：${userData.userName}\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次\n总可用次数：${totalAvailable}次\n历史总调用：${userData.totalUsageCount}次\n历史总充值：${userData.purchasedCount}次`
        
      } catch (error) {
        logger.error('查询额度失败', error)
        return '查询失败，请稍后重试'
      }
    })

  // 统计命令
  ctx.command('图像统计', '查看全局统计信息（仅管理员）')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      if (!config.adminUsers.includes(session.userId)) {
        return '权限不足，仅管理员可查看统计'
      }
      
      try {
        const usersData = await loadUsersData()
        const users = Object.values(usersData)
        
        const totalUsers = users.length
        const totalUsageCount = users.reduce((sum, user) => sum + user.totalUsageCount, 0)
        const totalPurchasedCount = users.reduce((sum, user) => sum + user.purchasedCount, 0)
        const totalRemainingPurchasedCount = users.reduce((sum, user) => sum + user.remainingPurchasedCount, 0)
        
        // 今日活跃用户
        const today = new Date().toDateString()
        const todayActiveUsers = users.filter(user => {
          const lastUsed = new Date(user.lastUsed).toDateString()
          return lastUsed === today
        }).length
        
        return `📊 全局统计信息\n总用户数：${totalUsers}人\n今日活跃：${todayActiveUsers}人\n总调用次数：${totalUsageCount}次\n总充值次数：${totalPurchasedCount}次\n剩余充值次数：${totalRemainingPurchasedCount}次\n平均每用户调用：${totalUsers > 0 ? Math.round(totalUsageCount / totalUsers) : 0}次`
        
      } catch (error) {
        logger.error('统计查询失败', error)
        return '统计查询失败，请稍后重试'
      }
    })

  // 充值记录查询命令
  ctx.command('图像充值记录 [page:number]', '查看充值历史记录（仅管理员）')
    .action(async ({ session }, page = 1) => {
      if (!session?.userId) return '会话无效'
      
      if (!config.adminUsers.includes(session.userId)) {
        return '权限不足，仅管理员可查看充值记录'
      }
      
      try {
        const history = await loadRechargeHistory()
        const pageSize = 10
        const totalPages = Math.ceil(history.records.length / pageSize)
        const startIndex = (page - 1) * pageSize
        const endIndex = startIndex + pageSize
        const records = history.records.slice(startIndex, endIndex).reverse() // 最新的在前
        
        if (records.length === 0) {
          return `📋 充值记录\n当前页：${page}/${totalPages}\n暂无充值记录`
        }
        
        let result = `📋 充值记录 (第${page}/${totalPages}页)\n\n`
        
        for (const record of records) {
          const date = new Date(record.timestamp).toLocaleString('zh-CN')
          const userList = record.targets.map(t => `${t.userName}(${t.amount}次)`).join(', ')
          result += `🕐 ${date}\n👤 操作员：${record.operator.userName}\n👥 目标：${userList}\n💰 总充值：${record.totalAmount}次\n📝 备注：${record.note}\n\n`
        }
        
        return result
        
      } catch (error) {
        logger.error('查询充值记录失败', error)
        return '查询失败，请稍后重试'
      }
    })

  // 数据恢复命令
  ctx.command('图像恢复备份', '从备份文件恢复数据（仅管理员）')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      if (!config.adminUsers.includes(session.userId)) {
        return '权限不足，仅管理员可恢复数据'
      }
      
      try {
        if (!existsSync(backupFile)) {
          return '备份文件不存在，无法恢复'
        }
        
        const backupData = await fs.readFile(backupFile, 'utf-8')
        const usersData = JSON.parse(backupData)
        
        // 备份当前数据
        if (existsSync(dataFile)) {
          await fs.copyFile(dataFile, join(dataDir, `users_data.json.backup.${Date.now()}`))
        }
        
        // 恢复备份数据
        await fs.writeFile(dataFile, JSON.stringify(usersData, null, 2), 'utf-8')
        
        return `✅ 数据恢复成功\n恢复时间：${new Date().toLocaleString('zh-CN')}\n用户数量：${Object.keys(usersData).length}人`
        
      } catch (error) {
        logger.error('数据恢复失败', error)
        return '数据恢复失败，请检查备份文件'
      }
    })

  // 图像功能列表命令
  ctx.command('图像功能', '查看所有可用的图像处理功能')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      
      try {
        // 获取当前用户的管理员状态
        const isAdmin = config.adminUsers.includes(session.userId)
        
        let result = '🎨 图像处理功能列表\n\n'
        
        // 显示非管理员指令
        result += '📝 用户指令：\n'
        commandRegistry.userCommands.forEach(cmd => {
          result += `• ${cmd.name} - ${cmd.description}\n`
        })
        
        // 如果用户是管理员，显示管理员指令
        if (isAdmin) {
          result += '\n🔧 管理员指令：\n'
          commandRegistry.adminCommands.forEach(cmd => {
            result += `• ${cmd.name} - ${cmd.description}\n`
          })
        }
        
        result += '\n💡 使用提示：\n'
        result += '• 发送图片后使用相应指令进行图像处理\n'
        result += '• 支持直接传参：.指令名 [图片] 参数\n'
        result += '• 支持交互式输入：.指令名 然后按提示操作\n'
        
        if (isAdmin) {
          result += '\n🔑 管理员提示：\n'
          result += '• 可使用所有功能，无使用限制\n'
          result += '• 可以查看统计信息和充值记录\n'
          result += '• 可以为其他用户充值次数\n'
        } else {
          result += '\n👤 普通用户提示：\n'
          result += '• 每日有免费使用次数限制\n'
          result += '• 可使用充值次数进行额外调用\n'
          result += '• 使用 .图像额度 查看剩余次数\n'
        }
        
        return result
        
      } catch (error) {
        logger.error('获取功能列表失败', error)
        return '获取功能列表失败，请稍后重试'
      }
    })

  logger.info('云雾图像处理插件已启动 (Gemini 2.5 Flash Image)')
}
