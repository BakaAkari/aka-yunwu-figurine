# aka-yunwu-figurine

基于云雾API的手办化插件，使用 fal-ai/nano-banana 模型将图片转换为高质量手办风格。

## 功能特性

- 🎨 支持图片手办化转换
- 🖼️ 支持文本生成图片（文生图）
- 🔄 异步任务处理，支持队列管理
- ⚡ 实时状态查询和进度显示
- 🛡️ 用户状态管理，防止重复调用
- 📊 详细的日志记录
- ⚙️ 灵活的配置选项
- 🎭 多种手办化风格预设

## 配置说明

在 Koishi 配置中添加以下配置：

```yaml
plugins:
  aka-yunwu-figurine:
    apiKey: 'your-yunwu-api-key'  # 云雾API密钥（必填）
    cooldownTime: 30              # 等待发送图片的时间（秒）
    apiTimeout: 120               # API请求超时时间（秒）
    pollInterval: 3               # 轮询间隔时间（秒）
    maxPollAttempts: 40           # 最大轮询次数
    enableLog: true               # 启用日志记录
    maxImageSize: 10              # 最大图片大小限制（MB）
    defaultStyle: 1               # 默认手办化风格（1-4）
    figurinePresets:              # 手办化风格预设文本
      - 'figurine, anime figure, detailed, high quality, professional photography, studio lighting'
      - 'chibi figurine, cute, kawaii style, pastel colors, soft lighting, collectible'
      - 'realistic figurine, premium quality, museum display, dramatic lighting, detailed craftsmanship'
      - 'fantasy figurine, magical, mystical atmosphere, ethereal lighting, enchanted'
```

## 使用方法

### 手办化命令

- `手办化` - 使用默认风格进行手办化（需要发送图片）
- `手办化 -s 2` - 使用风格2进行手办化
- `手办化状态` - 查询当前手办化任务状态
- `手办化重置` - 重置手办化处理状态

### 文生图命令（备用功能）

- `文生图 <提示词>` - 生成单张图片
- `文生图 -n 2 <提示词>` - 生成2张图片（最多4张）
- `文生图状态` - 查询当前文生图任务状态

### 使用示例

```
手办化 -s 1          # 使用风格1进行手办化，然后发送图片
手办化               # 使用默认风格，然后发送图片
文生图 一只可爱的小猫坐在花园里
手办化状态           # 查看当前任务状态
```

## API 说明

本插件使用云雾API的 `/fal-ai/nano-banana` 接口：

- **模型**: fal-ai/nano-banana
- **支持**: 文生图、图片转换
- **图片数量**: 1-4张
- **认证方式**: Bearer Token
- **手办化**: 通过预设提示词实现图片风格转换

## 手办化风格说明

插件提供4种预设手办化风格：

1. **标准手办风格** - 专业摄影，工作室灯光
2. **Q版可爱风格** - 萌系，柔和的色彩和灯光
3. **写实收藏风格** - 博物馆展示级别，戏剧性灯光
4. **奇幻魔法风格** - 神秘氛围，空灵灯光

## 技术架构

- **异步处理**: 提交任务后轮询状态
- **状态管理**: 防止用户重复调用
- **图片处理**: 支持多种图片格式和大小检测
- **等待机制**: 支持图片发送等待和超时处理
- **错误处理**: 完善的错误提示和重试机制
- **日志记录**: 详细的操作日志

## 注意事项

1. 需要有效的云雾API密钥
2. 手办化功能需要先发送图片，再使用命令
3. 提示词长度限制在500字符以内
4. 生成时间取决于队列长度，通常需要30秒-2分钟
5. 建议在网络良好的环境下使用
6. 支持JPG、PNG格式图片，大小建议1-10MB

## 版本信息

- 当前版本: 0.0.1
- 依赖: Koishi ^4.18.9
- 支持平台: 所有 Koishi 支持的平台
