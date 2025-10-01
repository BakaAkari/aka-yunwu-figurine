# Koishi 云雾API图像处理插件

使用云雾API进行图像编辑处理的Koishi插件。

## 功能特性

- 🖼️ **图像编辑处理**: 使用云雾API的 `/fal-ai/nano-banana/edit` 接口进行图像编辑
- 🎯 **智能图片识别**: 使用Koishi官方推荐的 `h.select()` 方法获取图片URL
- ⚙️ **灵活参数配置**: 支持自定义提示词和生成数量
- 📊 **完整状态管理**: 提供任务状态查询和重置功能
- 📝 **详细日志记录**: 基于Koishi Logger的完整日志系统
- 🔄 **自动轮询**: 自动轮询任务状态，无需手动检查

## 安装

```bash
npm install koishi-plugin-aka-yunwu-figurine
```

## 配置

在 `koishi.config.js` 中添加以下配置：

```javascript
export default {
  plugins: {
    'aka-yunwu-figurine': {
      apiKey: 'your-yunwu-api-key',        // 云雾API密钥 (必需)
      cooldownTime: 30,                    // 等待发送图片的时间（秒）
      apiTimeout: 120,                     // API请求超时时间（秒）
      pollInterval: 3,                     // 轮询间隔时间（秒）
      maxPollAttempts: 40,                 // 最大轮询次数
      maxImageSize: 10,                    // 最大图片大小限制（MB）
      
      // 图像处理相关配置
      imageEditPrompt: 'enhance this image, improve quality, professional photography style',
      imageEditNumImages: 1,               // 默认生成图片数量 (1-4)
      imageEditCooldownTime: 30,           // 图像处理等待时间（秒）
    }
  }
}
```

## 使用方法

### 基础用法

1. **开始图像处理**：
   ```
   图像处理
   ```

2. **发送图片**：
   发送任意图片到聊天窗口

3. **等待处理完成**：
   插件会自动处理图片并返回结果

### 高级用法

#### 自定义提示词和数量

```
图像处理 -p "make this image more vibrant and colorful" -n 2
```

- `-p`: 指定图像编辑提示词
- `-n`: 指定生成图片数量 (1-4)

#### 查询任务状态

```
图像处理状态
```

#### 重置任务状态

```
图像处理重置
```

#### 设置默认参数

```
图像处理设置 -p "enhance image quality" -n 3
```

## 命令列表

| 命令 | 描述 | 参数 |
|------|------|------|
| `图像处理` | 开始图像处理流程 | `-p <prompt>`: 提示词<br>`-n <num>`: 生成数量 |
| `图像处理状态` | 查询当前任务状态 | 无 |
| `图像处理重置` | 重置任务状态 | 无 |
| `图像处理设置` | 设置默认参数 | `-p <prompt>`: 提示词<br>`-n <num>`: 生成数量 |

## 工作流程

1. **用户发送指令**: `图像处理` 命令
2. **等待图片**: 插件等待用户发送图片
3. **图片识别**: 自动识别并提取图片URL
4. **API调用**: 调用云雾API进行图像编辑
5. **状态轮询**: 自动轮询任务处理状态
6. **返回结果**: 将处理后的图片发送给用户

## 日志配置

### 启用调试日志

```bash
# 命令行启动时启用debug
koishi run --debug

# 或设置日志级别
koishi run --log-level=3
```

### 配置文件中设置

```javascript
export default {
  logLevel: 3, // 全局日志级别 (0-3)
  logFilter: {
    'aka-yunwu-figurine': 3, // 插件专用debug级别
  }
}
```

### 日志级别说明

- `0`: 只显示错误
- `1`: 显示错误和成功
- `2`: 显示错误、成功和警告
- `3`: 显示所有日志（包含debug）

## API接口

本插件使用云雾API的图像编辑接口：

- **接口地址**: `POST https://yunwu.ai/fal-ai/nano-banana/edit`
- **结果查询**: `GET https://yunwu.ai/fal-ai/nano-banana/requests/{request_id}`

### 请求参数

```json
{
  "prompt": "图像编辑提示词",
  "image_url": "用户发送的图片URL",
  "num_images": 1
}
```

### 响应格式

```json
{
  "status": "IN_QUEUE",
  "request_id": "uuid",
  "response_url": "string",
  "status_url": "string",
  "cancel_url": "string",
  "queue_position": 0
}
```

## 技术特性

- **图片URL获取**: 使用Koishi官方推荐的 `h.select(session.elements, 'img')` 方法
- **状态管理**: 完整的用户状态管理和任务跟踪
- **错误处理**: 完善的错误处理和超时机制
- **日志系统**: 基于Koishi Logger的结构化日志记录
- **性能优化**: 智能轮询和内存管理

## 注意事项

1. **API密钥**: 需要有效的云雾API密钥
2. **图片格式**: 支持常见的图片格式（JPG、PNG、WebP等）
3. **网络要求**: 需要稳定的网络连接
4. **处理时间**: 图像处理可能需要几分钟时间
5. **并发限制**: 每个用户同时只能处理一个任务

## 更新日志

### v1.0.0
- 完全重构为图像处理插件
- 移除原有文生图功能
- 使用Koishi Logger日志系统
- 优化用户状态管理
- 改进错误处理机制

## 许可证

MIT License