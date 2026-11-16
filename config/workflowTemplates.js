// 电商工作流模板（纯数据，无数据库依赖，供 database/db.js 初始化）
//
// 节点字段说明：
//   key      节点唯一标识，同一条工作流内不可重复
//   name     节点显示名
//   type     image_edit（需要参考图）/ image_generate（纯文生图）
//   source   参考图来源，逗号分隔，支持：
//              input:<输入组key>  该组全部图片
//              prev               上一个节点的输出
//              node:<节点key>     指定节点的输出
//   prompt   发给模型的指令
//   size     默认画面比例（可被运行时的比例覆盖）
//   note     节点卡片上的一行说明
//
// 重要经验（2026-11-16 实测）：
//   1. 图生图接口（/images/edits）没有 negative_prompt 字段，写负面词不生效；
//      把负面词拼进 prompt 反而会让模型盯着“站立/悬浮”生成那种姿势。
//   2. 所以模板里只写正向描述：先锁死“保持原图姿态和朝向，只换背景”，
//      再用具体、可执行的摆放动作（放进浅盘、放在木板上、仍在藤上）代替“不要立起来”。

// 所有节点共用：锁住商品本体，只改环境。
const KEEP_PRODUCT = 'Keep the product itself completely unchanged: same shape, same proportions, same colour and material, same camera angle, and the same way it is already resting in the reference photo. Only replace what surrounds it.';

const CLEAN_OUTPUT = 'Clean commercial photography: soft directional daylight, realistic contact shadows, true scale, sharp focus where it matters. No text, no watermark, no border, no extra props.';

const WORKFLOW_TEMPLATES = [
  {
    key: 'main_image_set',
    name: '电商主图套图',
    summary: '上传一张产品图，自动产出白底图、场景主图、细节特写和留白主图；四张都从原图独立生成，商品保持原图里的真实姿态。',
    category: 'ecommerce',
    emoji: '📦',
    badge: '最常用',
    sort_order: 10,
    inputs: [
      {
        key: 'product',
        label: '商品图',
        hint: '正面、清晰、背景干净的照片效果最好，最多 3 张',
        min: 1,
        max: 3
      }
    ],
    nodes: [
      {
        key: 'white_bg',
        name: '白底精修',
        type: 'image_edit',
        source: 'input:product',
        size: '1:1',
        note: '去背景 + 白底 + 接触阴影',
        prompt: `Professional e-commerce product photo on a pure white background (#FFFFFF). ${KEEP_PRODUCT} Replace the original background with clean white, keeping the product cut out along its real edges at the same size and position, with a soft contact shadow directly under wherever it already touches the ground. Even studio lighting, crisp edges. ${CLEAN_OUTPUT}`
      },
      {
        key: 'scene',
        name: '场景主图',
        type: 'image_edit',
        source: 'input:product',
        size: '1:1',
        note: '保持原图姿态，只把背景换成生活场景',
        prompt: `Take the product from the reference photo and place it into a bright, natural lifestyle scene. ${KEEP_PRODUCT} Build the setting around it so the product still looks exactly as it does now — if it is hanging, it hangs; if it is lying on something, it keeps lying the same way on a matching surface. Pick a setting that genuinely suits this product: a sunlit table or garden for food, a clean bright counter for skincare, a modern interior for home goods, an outdoor scene for fashion. Match the light direction and surface to the product's existing orientation, with realistic contact shadows, true scale, and a shallow depth of field. Compose with the product as the focal point and clean breathing room around it. ${CLEAN_OUTPUT}`
      },
      {
        key: 'detail',
        name: '细节特写',
        type: 'image_edit',
        source: 'input:product',
        size: '1:1',
        note: '微距质感，突出材质做工',
        prompt: `Macro close-up of the product in the reference photo, cropped into a real part of it — a texture patch, a seam, a surface finish, or the skin of the fruit. ${KEEP_PRODUCT} Zoom in on one true detail and keep its actual texture, colour, and structure intact. Shallow depth of field so that detail is tack sharp while the rest falls softly out of focus, with soft directional light revealing surface texture. ${CLEAN_OUTPUT}`
      },
      {
        key: 'hero_space',
        name: '留白主图',
        type: 'image_edit',
        source: 'input:product',
        size: '1:1',
        note: '右侧留白，方便后期加卖点文案',
        prompt: `E-commerce hero image with copy space. ${KEEP_PRODUCT} Keep the product at its current pose and size and simply extend the scene around it, continuing the same background, light direction, and surface so the picture stays seamless. Leave a large clean empty area on the right side for marketing copy, with a gentle brightness falloff towards that side. Do not put any text, numbers, icons, watermark, or border in the image.`
      }
    ]
  },
  {
    key: 'detail_page',
    name: '详情页整套',
    summary: '主视觉、使用场景、细节三屏一套出齐，直接拼详情页。',
    category: 'ecommerce',
    emoji: '📄',
    badge: '',
    sort_order: 20,
    inputs: [
      {
        key: 'product',
        label: '商品图',
        hint: '建议上传正面、侧面、细节各一张',
        min: 1,
        max: 3
      }
    ],
    nodes: [
      {
        key: 'hero',
        name: '首屏主视觉',
        type: 'image_edit',
        source: 'input:product',
        size: '3:4',
        note: '详情页第一屏，氛围感最强',
        prompt: '以图中的商品为主体，创作详情页首屏主视觉：商品置于画面上方三分之二处，背景是有层次的柔和光影和虚化的环境元素，下方保留干净的渐变留白，方便叠加标题。整体色调统一、高级、有品牌感，光线柔和有方向性。商品的颜色、材质和 logo 必须保持原样。不要添加任何文字、水印或边框。'
      },
      {
        key: 'usage',
        name: '使用场景',
        type: 'image_edit',
        source: 'input:product',
        size: '3:4',
        note: '真实使用场景，增强代入感',
        prompt: '保持图中商品的款式、颜色和材质不变，生成一张真实自然的使用场景图：商品正在被正常使用（例如手持、佩戴、摆放在真实生活空间里），画面里可以出现自然的人物手部或人物局部，但要保持商品是视觉焦点。光线自然，氛围生活化，构图真实不摆拍。不要添加任何文字、水印或边框。'
      },
      {
        key: 'closeup',
        name: '材质细节',
        type: 'image_edit',
        source: 'input:product',
        size: '3:4',
        note: '放大质感，支撑价格感',
        prompt: '对图中商品做近距离材质细节展示：局部放大，突出纹理、缝线、按键、接口或表面工艺。使用柔和的方向性光线勾勒轮廓，背景虚化，画面干净克制。保留商品真实颜色和细节，不要美化到失真。不要添加任何文字、水印或边框。'
      }
    ]
  },
  {
    key: 'poster_replica',
    name: '爆款海报复刻',
    summary: '给一张参考海报和一张产品图，保留版式把产品换进去。',
    category: 'ecommerce',
    emoji: '🖼️',
    badge: '新品',
    sort_order: 30,
    inputs: [
      {
        key: 'reference',
        label: '参考海报',
        hint: '想复刻的那张图，1 张',
        min: 1,
        max: 1
      },
      {
        key: 'product',
        label: '你的商品图',
        hint: '要被放进版式的商品，1 张',
        min: 1,
        max: 1
      }
    ],
    nodes: [
      {
        key: 'replica',
        name: '版式复刻',
        type: 'image_edit',
        source: 'input:reference,input:product',
        size: '3:4',
        note: '换商品、保版式、保配色',
        prompt: '第一张图是版式参考，第二张图是要使用的商品。请严格保留第一张图的构图、留白位置、配色方案、光影方向和视觉层级，把第二张图中的商品自然地替换进版式中原来的商品位置，并匹配参考图的光线、色温和透视关系。商品本身的颜色、材质和 logo 必须保持真实，不要改变形状。画面中不要新增任何文字；如果参考图里已有文字，保持文字的位置、大小和排版不变，不要改写内容。'
      }
    ]
  },
  {
    key: 'model_swap',
    name: '换模特试穿',
    summary: '把商品穿到模特身上，再补一张街拍背景。',
    category: 'ecommerce',
    emoji: '👗',
    badge: '',
    sort_order: 40,
    inputs: [
      {
        key: 'product',
        label: '商品图',
        hint: '服装平铺图或挂拍图均可',
        min: 1,
        max: 1
      },
      {
        key: 'model',
        label: '模特参考（可选）',
        hint: '想指定脸型/风格时上传，最多 1 张',
        min: 0,
        max: 1,
        required: false
      }
    ],
    nodes: [
      {
        key: 'on_model',
        name: '模特上身',
        type: 'image_edit',
        source: 'input:product,input:model',
        size: '3:4',
        note: '影棚布光，真实穿着效果',
        prompt: '把图中的商品真实地穿到一位 25 岁左右的亚洲女性模特身上。如果提供了第二张人物参考图，请保持参考图中人物的面部特征、发型和气质；如果没有，则生成一位气质自然的模特。服装的版型、颜色、图案、纽扣和 logo 必须与商品图完全一致，褶皱和垂坠要符合真实面料。自然站姿，七分身构图，浅灰色纯色影棚背景，柔和均匀的商业摄影布光。不要添加任何文字、水印或边框。'
      },
      {
        key: 'street',
        name: '街拍背景',
        type: 'image_edit',
        source: 'prev',
        size: '3:4',
        note: '换城市街景，提升氛围',
        prompt: '保持画面中模特的外貌、姿势和所穿服装完全不变，把背景替换成真实自然的城市街拍场景：虚化的街道、店铺橱窗和行道树，傍晚柔和的光线，有轻微景深。整体色调温暖通透，像时尚博主的街拍照片。服装的颜色和细节必须保持不变。不要添加任何文字、水印或边框。'
      }
    ]
  },
  {
    key: 'product_retouch',
    name: '商品精修',
    summary: '一张普通的随手拍，精修成商拍级质感。',
    category: 'ecommerce',
    emoji: '✨',
    badge: '',
    sort_order: 50,
    inputs: [
      {
        key: 'product',
        label: '商品图',
        hint: '手机随手拍也可以，1 张',
        min: 1,
        max: 1
      }
    ],
    nodes: [
      {
        key: 'retouch',
        name: '商拍精修',
        type: 'image_edit',
        source: 'input:product',
        size: '1:1',
        note: '去瑕疵、正色、提质感',
        prompt: '对图中的商品做专业商业摄影级别的精修：去除表面的灰尘、污渍、指纹和划痕，清理背景里多余的杂物，统一白平衡并校正色偏，增强材质的对比度和高光层次，让金属更有光泽、织物更有纹理、塑料更通透。输出纯白或浅灰渐变背景的高清商拍图，光线均匀柔和，商品边缘干净。必须保持商品的真实颜色、形状、logo 和所有结构细节不变，不要添加任何文字、水印或边框。'
      }
    ]
  }
];

module.exports = { WORKFLOW_TEMPLATES };
