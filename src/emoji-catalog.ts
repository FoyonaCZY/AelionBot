export interface PinEmojiOption {emoji:string;label:string;keywords:string;}
export interface PinEmojiCategory {id:string;name:string;icon:string;items:PinEmojiOption[];}
const category=(id:string,name:string,icon:string,source:string):PinEmojiCategory=>({id,name,icon,items:source.trim().split('\n').map(line=>{const [emoji,label,...words]=line.trim().split(/\s+/);return {emoji,label,keywords:`${label} ${words.join(' ')}`.toLowerCase()};})});

export const PIN_EMOJI_CATEGORIES:PinEmojiCategory[]=[
  category('faces','表情','😀',`
😀 笑脸 开心 happy smile
😃 大笑 开心 smile
😄 开怀大笑 happy
😁 露齿笑 grin
😆 笑眯眼 laugh
😅 笑着流汗 尴尬 sweat
😂 开心 笑哭 laugh joy
🤣 笑翻了 大笑 rofl
🥲 含泪微笑 感动
😊 害羞 微笑 blush
😇 天使 无辜 angel
🙂 微笑 smile
🙃 倒脸 无奈 upside
😉 眨眼 wink
😌 放松 如释重负 relieved
😍 花痴 爱慕 heart eyes
🥰 幸福 喜爱 love
😘 飞吻 kiss
😗 亲亲 kiss
😙 眯眼亲亲 kiss
😚 闭眼亲亲 kiss
😋 美味 馋 yummy
😛 吐舌 调皮 tongue
😝 调皮大笑 tongue
😜 眨眼吐舌 wink
🤪 疯狂 搞怪 crazy
🤨 挑眉 怀疑 skeptical
🧐 仔细观察 研究 monocle
🤓 书呆子 学习 nerd
😎 酷 墨镜 cool
🥸 伪装 disguise
🤩 崇拜 星星眼 star
🥳 派对 庆祝 party
😏 得意 坏笑 smirk
😒 不高兴 无语 unamused
😞 失望 disappointed
😔 低落 沮丧 sad
😟 担心 worried
😕 困惑 confused
🙁 不开心 sad
☹️ 难过 frown
😣 苦恼 痛苦
😖 纠结 痛苦
😫 疲惫 tired
😩 崩溃 tired
🥺 恳求 可怜 pleading
🥹 感动 忍住泪水
😢 哭泣 sad cry
😭 大哭 委屈 sob
😤 气鼓鼓 愤怒
😠 生气 angry
😡 愤怒 rage
🤬 暴怒 骂人 angry
🤯 震惊 头脑爆炸 mind blown
😳 脸红 惊讶 flushed
🥵 热死了 hot
🥶 冷死了 cold
😱 惊恐 scream
😨 害怕 fear
😰 紧张 焦虑 sweat
😥 失望流汗
😓 汗 伤脑筋
🤗 抱抱 拥抱 hug
🤔 思考 想想 think
🫡 敬礼 收到 salute
🤭 捂嘴 偷笑
🫢 惊讶捂嘴
🫣 偷看 害羞
🤫 嘘 安静 quiet
🤥 说谎 长鼻子 lie
😶 沉默 无话可说 silent
😐 面无表情 neutral
😑 无语 expressionless
😬 尴尬 grimace
🙄 翻白眼 无语 eyes
😯 吃惊 surprised
😦 惊讶
😧 担忧
😮 张大嘴 wow
😲 目瞪口呆 wow
🥱 打哈欠 困 sleepy
😴 睡觉 sleep
🤤 流口水 drool
😪 困倦 sleepy
😵 头晕 dizzy
🤐 闭嘴 保密 zip
🥴 迷糊 微醺 woozy
🤢 恶心 sick
🤮 呕吐 sick
🤧 打喷嚏 sneeze
😷 口罩 mask
🤒 发烧 sick
🤕 受伤 bandage
🤑 发财 钱 money
🤠 牛仔 cowboy
😈 小恶魔 devil
👿 愤怒恶魔 devil
👻 幽灵 ghost
💀 骷髅 skull
☠️ 骷髅旗危险 skull
👽 外星人 alien
🤖 机器人 bot robot
💩 便便 poop
🤡 小丑 clown
😺 猫咪笑脸 cat
😸 猫咪开心 cat
😹 猫咪笑哭 cat
😻 猫咪花痴 cat love
😼 猫咪坏笑 cat
😽 猫咪亲亲 cat kiss
🙀 猫咪惊恐 cat
😿 猫咪哭泣 cat
😾 猫咪生气 cat
🙈 不敢看 猴 monkey
🙉 不想听 猴 monkey
🙊 不说话 猴 monkey
`),
  category('gestures','手势与人物','👋',`
👍 赞同 好棒 点赞 yes thumbs up
👎 不赞同 反对 no thumbs down
👏 鼓掌 掌声 clap
🙌 欢呼 举手 hooray
👐 张开双手 open
🤲 双手捧起 palms
🤝 握手 合作 handshake
🙏 感谢 拜托 祈祷 thanks pray
🫶 比心 爱 heart hands
💪 加油 力量 muscle
🦾 机械臂 强大 robot
👋 挥手 你好 再见 wave hello bye
🤚 举手 raised
✋ 停止 举手 stop
🖐️ 五指手掌 hand
👌 没问题 好的 ok
🤌 捏手 fingers
🤏 一点点 tiny
✌️ 胜利 耶 victory peace
🤞 祝好运 fingers crossed
🤟 爱你 love
🤘 摇滚 rock
🤙 打电话 call
👈 向左 指 left
👉 向右 指 right
👆 向上 指 up
👇 向下 指 down
☝️ 注意 一点 point
👊 拳头 fist
✊ 加油 握拳 fist
🤛 左拳 fist
🤜 右拳 fist
🫰 手指比心 money
✍️ 书写 记录 write
💅 美甲 优雅 nails
👀 关注 眼睛 看 eyes look
👁️ 眼睛 eye
👂 倾听 耳朵 listen
🧠 大脑 灵感 brain
🫀 心脏 heart
🫂 拥抱 hug
👤 人物 user person
👥 伙伴 团队 people team
👶 婴儿 baby
🧒 孩子 child
👩 女性 woman
👨 男性 man
🧑 人 person
👵 老奶奶 grandma
👴 老爷爷 grandpa
👮 警察 police
🕵️ 侦探 detective
🥷 忍者 ninja
🧙 法师 wizard
🧚 精灵 fairy
🧛 吸血鬼 vampire
🧟 僵尸 zombie
🦸 超级英雄 superhero
🦹 反派 villain
💃 跳舞 dance
🕺 舞者 dance
🏃 跑步 run
🚶 散步 walk
🧘 冥想 放松 meditate
`),
  category('hearts','爱心与符号','❤️',`
❤️ 喜欢 爱心 love heart
🧡 橙色爱心 orange heart
💛 黄色爱心 yellow heart
💚 绿色爱心 green heart
💙 蓝色爱心 blue heart
💜 紫色爱心 purple heart
🤎 棕色爱心 brown heart
🖤 黑色爱心 black heart
🤍 白色爱心 white heart
💔 心碎 broken heart
❤️‍🔥 热恋 火热的心 fire heart
❤️‍🩹 治愈 心伤 mending heart
❣️ 心形叹号 heart
💕 两颗心 love
💞 心心相印 love
💓 心跳 beating heart
💗 心动 growing heart
💖 闪亮的心 sparkling heart
💘 爱神之箭 cupid
💝 爱心礼物 gift heart
💟 爱心装饰 heart
💯 满分 一百分 perfect
✅ 完成 正确 done check
☑️ 已选中 check
✔️ 勾 确认 check
❌ 错误 取消 wrong cross
❎ 否决 cross
⭕ 圈 正确 circle
❓ 疑问 问题 question
❔ 白色问号 question
❗ 重要 感叹号 exclamation
❕ 白色叹号 exclamation
‼️ 双叹号 注意
⁉️ 惊疑 为什么
⚠️ 注意 警告 warning
⛔ 禁止进入 stop
🚫 禁止 no
♻️ 回收 循环 recycle
🔁 重复 循环 repeat
🔄 刷新 重新来 refresh
🔀 随机 交换 shuffle
⏸️ 暂停 pause
▶️ 开始 播放 play
⏹️ 停止 stop
🔴 红色圆点 red
🟠 橙色圆点 orange
🟡 黄色圆点 yellow
🟢 绿色圆点 green
🔵 蓝色圆点 blue
🟣 紫色圆点 purple
⚫ 黑色圆点 black
⚪ 白色圆点 white
`),
  category('nature','动物与自然','🐱',`
🐱 猫咪 cat
🐶 狗狗 dog
🐭 老鼠 mouse
🐹 仓鼠 hamster
🐰 兔子 rabbit
🦊 狐狸 fox
🐻 熊 bear
🐼 熊猫 panda
🐨 考拉 koala
🐯 老虎 tiger
🦁 狮子 lion
🐮 牛 cow
🐷 猪 pig
🐸 青蛙 frog
🐵 猴子 monkey
🐔 鸡 chicken
🐧 企鹅 penguin
🐦 小鸟 bird
🦆 鸭子 duck
🦅 老鹰 eagle
🦉 猫头鹰 owl
🦇 蝙蝠 bat
🐺 狼 wolf
🐴 马 horse
🦄 独角兽 unicorn
🐝 蜜蜂 bee
🐛 毛毛虫 bug
🦋 蝴蝶 butterfly
🐌 蜗牛 snail
🐞 瓢虫 ladybug
🐢 乌龟 turtle
🐍 蛇 snake
🐙 章鱼 octopus
🦑 鱿鱼 squid
🦀 螃蟹 crab
🦐 虾 shrimp
🐠 热带鱼 fish
🐟 鱼 fish
🐬 海豚 dolphin
🐳 鲸鱼 whale
🦈 鲨鱼 shark
🐊 鳄鱼 crocodile
🦖 恐龙 dinosaur
🐉 龙 dragon
🌵 仙人掌 cactus
🎄 圣诞树 christmas
🌲 常青树 tree
🌳 大树 tree
🌴 棕榈树 palm
🌱 发芽 成长 seedling
🌿 草本 叶子 herb
☘️ 三叶草 clover
🍀 幸运 四叶草 lucky
🍁 枫叶 maple
🍂 落叶 autumn
🍃 叶子 微风 leaf
🌸 樱花 cherry blossom
🌹 玫瑰 rose
🌻 向日葵 sunflower
🌼 小花 flower
🌷 郁金香 tulip
🌺 鲜花 hibiscus
🌾 稻穗 rice
🍄 蘑菇 mushroom
🌍 地球 world
🌎 美洲地球 earth
🌏 亚洲地球 earth
🌕 满月 moon
🌙 月亮 夜晚 moon
☀️ 太阳 晴天 sun
🌤️ 晴间多云 weather
☁️ 云 cloud
🌧️ 下雨 rain
⛈️ 雷雨 storm
🌈 彩虹 rainbow
❄️ 雪花 snow
☃️ 雪人 snowman
⚡ 闪电 快 lightning
🔥 火 热门 fire
💧 水滴 water
🌊 海浪 wave
🌟 闪耀星星 star
⭐ 星星 star
✨ 闪亮 魔法 sparkles
💫 眩晕 星光 dizzy
☄️ 彗星 comet
`),
  category('food','食物与饮品','🍔',`
🍎 苹果 apple
🍏 青苹果 apple
🍐 梨 pear
🍊 橘子 orange
🍋 柠檬 lemon
🍌 香蕉 banana
🍉 西瓜 watermelon
🍇 葡萄 grape
🍓 草莓 strawberry
🍒 樱桃 cherry
🍑 桃子 peach
🥭 芒果 mango
🍍 菠萝 pineapple
🥥 椰子 coconut
🥝 猕猴桃 kiwi
🍅 番茄 tomato
🥑 牛油果 avocado
🥦 西兰花 broccoli
🥕 胡萝卜 carrot
🌽 玉米 corn
🌶️ 辣椒 spicy
🥒 黄瓜 cucumber
🥔 土豆 potato
🍞 面包 bread
🥐 牛角包 croissant
🥖 法棍 baguette
🧀 奶酪 cheese
🥚 鸡蛋 egg
🍳 煎蛋 cooking
🥞 松饼 pancake
🧇 华夫饼 waffle
🥓 培根 bacon
🥩 牛排 meat
🍗 鸡腿 chicken
🍖 肉 bone meat
🌭 热狗 hotdog
🍔 汉堡 burger
🍟 薯条 fries
🍕 披萨 pizza
🥪 三明治 sandwich
🌮 塔可 taco
🥗 沙拉 salad
🍿 爆米花 popcorn
🍱 便当 bento
🍘 米饼 cracker
🍙 饭团 rice
🍚 米饭 rice
🍜 拉面 面条 noodle
🍝 意大利面 pasta
🍣 寿司 sushi
🥟 饺子 dumpling
🥮 月饼 mooncake
🍢 关东煮 oden
🍡 团子 dango
🍦 冰淇淋 icecream
🍨 冰激凌 icecream
🍩 甜甜圈 donut
🍪 饼干 cookie
🎂 生日蛋糕 birthday cake
🍰 蛋糕 cake
🧁 杯子蛋糕 cupcake
🍫 巧克力 chocolate
🍬 糖果 candy
🍭 棒棒糖 lollipop
🍯 蜂蜜 honey
🥛 牛奶 milk
☕ 咖啡 coffee
🍵 茶 tea
🧋 奶茶 珍珠奶茶 boba
🧃 果汁 juice
🥤 饮料 可乐 cola
🍺 啤酒 beer
🍻 干杯 啤酒 cheers
🥂 碰杯 庆祝 cheers
🍷 红酒 wine
🍸 鸡尾酒 cocktail
🍹 热带饮料 cocktail
🍾 香槟 champagne
`),
  category('activity','活动与出行','🚀',`
🎉 庆祝 彩带 party
🎊 彩球 庆贺 confetti
🎁 礼物 gift
🎈 气球 balloon
🎀 蝴蝶结 ribbon
🏆 奖杯 胜利 trophy
🥇 金牌 第一 gold
🥈 银牌 第二 silver
🥉 铜牌 第三 bronze
🏅 奖章 medal
🎖️ 荣誉 medal
🎯 命中 目标 target
🎮 游戏 game
🕹️ 游戏摇杆 joystick
🎲 骰子 dice
🧩 拼图 puzzle
♟️ 国际象棋 chess
🎰 好运 娱乐 slot
⚽ 足球 football
🏀 篮球 basketball
🏈 橄榄球 football
⚾ 棒球 baseball
🎾 网球 tennis
🏐 排球 volleyball
🏓 乒乓球 pingpong
🏸 羽毛球 badminton
🥊 拳击 boxing
🎱 台球 billiard
⛳ 高尔夫 golf
🏊 游泳 swim
🚴 骑车 cycling
🏋️ 举重 fitness
⛷️ 滑雪 ski
🏄 冲浪 surf
🎨 绘画 艺术 art
🎭 戏剧 表演 theater
🎬 电影 开拍 movie
🎤 唱歌 麦克风 sing
🎧 耳机 音乐 headphone
🎼 乐谱 music
🎵 音符 music
🎶 旋律 音乐 music
🎸 吉他 guitar
🎹 钢琴 piano
🥁 鼓 drum
🎺 小号 trumpet
🎻 小提琴 violin
🚗 汽车 car
🚕 出租车 taxi
🚌 公交车 bus
🚑 救护车 ambulance
🚒 消防车 firetruck
🚲 自行车 bike
🛵 小摩托 scooter
🏎️ 赛车 race
🚄 高铁 train
🚆 火车 train
✈️ 飞机 出发 plane
🚁 直升机 helicopter
🚀 火箭 起飞 rocket
🛸 飞碟 ufo
🚢 轮船 ship
⛵ 帆船 sailboat
⚓ 锚 anchor
🧳 行李 旅行 travel
🗺️ 地图 map
🧭 指南针 compass
🏠 房子 home
🏢 办公楼 office
🏰 城堡 castle
🏔️ 雪山 mountain
🏖️ 沙滩 beach
🏕️ 露营 camp
🌅 日出 sunrise
🌃 夜景 night
🌉 大桥 bridge
🎡 摩天轮 ferris
🎢 过山车 rollercoaster
`),
  category('objects','物品与工作','💡',`
💡 灵感 灯泡 idea
🔦 手电 flashlight
🕯️ 蜡烛 candle
💻 电脑 笔记本 code laptop
🖥️ 台式电脑 桌面 desktop
⌨️ 键盘 keyboard
🖱️ 鼠标 mouse
📱 手机 phone
☎️ 电话 telephone
📞 电话听筒 call
🔋 电池 充电 battery
🔌 插头 电源 plug
💾 保存 软盘 save
💿 光盘 disk
📷 相机 camera
📸 拍照 photo
🎥 摄像机 movie
📺 电视 tv
📡 天线 通信 satellite
🛰️ 卫星 satellite
🔍 查找 搜索 search
🔎 细查 搜索 search
📌 图钉 置顶 pin
📍 位置 定位 location
📝 记录 备忘 note
📄 文件 文档 document
📃 卷页 document
📋 剪贴板 清单 clipboard
📁 文件夹 folder
📂 打开文件夹 folder
🗂️ 分类 分隔卡 index
📚 书籍 books
📖 读书 阅读 read
📕 红色书本 book
📗 绿色书本 book
📘 蓝色书本 book
📙 橙色书本 book
📓 笔记本 notebook
📔 日记 notebook
✏️ 铅笔 pencil
🖊️ 圆珠笔 pen
🖋️ 钢笔 pen
🖌️ 画笔 brush
📐 三角尺 ruler
📏 直尺 ruler
📎 回形针 附件 clip
🖇️ 连接 附件 clips
✂️ 剪刀 scissors
🗑️ 垃圾桶 删除 trash
📤 发出 上传 outbox
📥 收到 下载 inbox
📦 包裹 打包 package
✉️ 信件 mail
📧 电子邮件 email
💌 情书 love letter
📮 邮筒 post
📣 通知 宣布 megaphone
📢 广播 loudspeaker
🔔 提醒 铃铛 bell
🔕 静音 mute
📅 日历 日期 calendar
🗓️ 日程 schedule
⏰ 闹钟 alarm
⏱️ 计时 stopwatch
⌛ 等待 沙漏 wait
⏳ 进行中 沙漏 pending
⌚ 手表 watch
📊 图表 分析 chart
📈 上涨 趋势 growth
📉 下跌 chart
🔧 修复 扳手 fix wrench
🔨 锤子 hammer
🛠️ 工具 维修 tools
⚙️ 设置 配置 gear
🔩 螺丝 bolt
🧰 工具箱 toolbox
🔗 链接 link
⛓️ 链条 chain
🔒 上锁 安全 lock
🔓 解锁 unlock
🔑 钥匙 key
🗝️ 旧钥匙 key
🛡️ 防护 盾牌 shield
🧪 实验 测试 test
🔬 显微镜 研究 science
🧬 基因 科学 dna
🔭 望远镜 telescope
💎 钻石 珍贵 diamond
💰 钱袋 money
💸 花钱 money
💵 钞票 money
💳 银行卡 card
🧲 磁铁 magnet
🧹 清扫 broom
🧼 清洁 soap
🧽 海绵 sponge
🧯 灭火器 修复 fire
🎆 烟花 fireworks
🎇 烟火 sparkler
🧨 鞭炮 firecracker
💥 爆炸 突破 boom
💤 睡觉 休息 sleep
💬 聊天 对话 chat
💭 想法 思考 thought
🗯️ 发言 speech
`)
];
export const PIN_EMOJI_OPTIONS=PIN_EMOJI_CATEGORIES.flatMap(category=>category.items);
export const PIN_EMOJI_BY_VALUE=new Map(PIN_EMOJI_OPTIONS.map(option=>[option.emoji,option]));
export const QUICK_PIN_EMOJIS=['👍','👎','❤️','😂','🎉','🤔'];
export function searchPinEmojis(query:string,categoryId='all'){
  const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const options=words.length||categoryId==='all'?PIN_EMOJI_OPTIONS:PIN_EMOJI_CATEGORIES.find(category=>category.id===categoryId)?.items||[];
  return words.length?options.filter(option=>words.every(word=>`${option.emoji} ${option.keywords}`.includes(word))):options;
}
