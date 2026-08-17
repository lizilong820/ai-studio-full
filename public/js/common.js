// Common utilities for AI Studio site

// Toast notification
function showToast(message, type = 'info') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

function renderModelOptions(select, models, formatLabel, emptyText = '暂无可用模型') {
  if (!select) return;
  select.replaceChildren();
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyText;
    select.appendChild(option);
    return;
  }
  list.forEach(model => {
    const option = document.createElement('option');
    option.value = String(model.id ?? '');
    option.textContent = String(formatLabel(model));
    option.selected = Boolean(model.is_default);
    select.appendChild(option);
  });
}

// Toggle switch
function setupToggles() {
  document.querySelectorAll('.toggle-switch').forEach(toggle => {
    toggle.addEventListener('click', function() {
      this.classList.toggle('active');
      const isOn = this.classList.contains('active');
      const input = this.querySelector('input[type="hidden"]');
      if (input) input.value = isOn ? '1' : '0';
    });
  });
}

// Option groups (radio-like selection)
function setupOptionGroups() {
  document.querySelectorAll('.option-group').forEach(group => {
    const options = group.querySelectorAll('.option-item');
    options.forEach(opt => {
      opt.addEventListener('click', function() {
        options.forEach(o => o.classList.remove('active'));
        this.classList.add('active');
        updateCost();
      });
    });
  });
}

// Color palette
function setupColorPalettes() {
  document.querySelectorAll('.color-palette').forEach(palette => {
    const colors = palette.querySelectorAll('.color-option');
    colors.forEach(color => {
      color.addEventListener('click', function() {
        colors.forEach(c => c.classList.remove('active'));
        this.classList.add('active');
      });
    });
  });
}

// Sliders
function setupSliders() {
  document.querySelectorAll('.slider-container').forEach(container => {
    const slider = container.querySelector('.slider');
    const valueDisplay = container.querySelector('.slider-value');
    if (slider && valueDisplay) {
      slider.addEventListener('input', function() {
        valueDisplay.textContent = this.value + (this.dataset.suffix || '');
        updateCost();
      });
    }
  });
}

// Collapsible sections
function setupCollapsibleSections() {
  document.querySelectorAll('.form-section').forEach(section => {
    const header = section.querySelector('.form-section-header');
    if (header) {
      header.addEventListener('click', function() {
        section.classList.toggle('collapsed');
      });
    }
  });
}

// Tag input
function setupTagInputs() {
  document.querySelectorAll('.tag-input-wrapper').forEach(wrapper => {
    const input = wrapper.querySelector('.tag-input');
    if (!input) return;
    
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const value = this.value.trim().replace(/,/g, '');
        if (value) {
          addTag(wrapper, value);
          this.value = '';
        }
      } else if (e.key === 'Backspace' && !this.value) {
        const tags = wrapper.querySelectorAll('.tag-item');
        if (tags.length > 0) {
          tags[tags.length - 1].remove();
        }
      }
    });
  });
}

function addTag(wrapper, text) {
  const input = wrapper.querySelector('.tag-input');
  const tag = document.createElement('span');
  const close = document.createElement('span');
  tag.className = 'tag-item';
  tag.appendChild(document.createTextNode(text));
  close.className = 'tag-close';
  close.textContent = '×';
  close.addEventListener('click', function() {
    tag.remove();
  });
  tag.appendChild(close);
  wrapper.insertBefore(tag, input);
}

// Number steppers
function setupSteppers() {
  document.querySelectorAll('.number-stepper').forEach(stepper => {
    const input = stepper.querySelector('.stepper-input');
    const minusBtn = stepper.querySelector('.stepper-btn.minus');
    const plusBtn = stepper.querySelector('.stepper-btn.plus');
    const min = parseInt(input.min) || 1;
    const max = parseInt(input.max) || 999;
    
    minusBtn.addEventListener('click', function() {
      let val = parseInt(input.value) || min;
      if (val > min) {
        input.value = val - 1;
        input.dispatchEvent(new Event('change'));
      }
    });
    
    plusBtn.addEventListener('click', function() {
      let val = parseInt(input.value) || min;
      if (val < max) {
        input.value = val + 1;
        input.dispatchEvent(new Event('change'));
      }
    });
    
    input.addEventListener('change', function() {
      let val = parseInt(this.value) || min;
      val = Math.max(min, Math.min(max, val));
      this.value = val;
      updateCost();
    });
  });
}

// Upload area
function setupUploads() {
  document.querySelectorAll('.upload-area').forEach(area => {
    const input = area.querySelector('input[type="file"]');
    area.addEventListener('click', function(e) {
      if (e.target.tagName !== 'INPUT') {
        input.click();
      }
    });
    
    area.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.style.borderColor = 'var(--brand)';
      this.style.background = 'rgba(124, 92, 255, 0.1)';
    });
    
    area.addEventListener('dragleave', function() {
      this.style.borderColor = '';
      this.style.background = '';
    });
    
    area.addEventListener('drop', function(e) {
      e.preventDefault();
      this.style.borderColor = '';
      this.style.background = '';
      if (e.dataTransfer.files.length > 0) {
        input.files = e.dataTransfer.files;
        handleFileUpload(area, e.dataTransfer.files);
      }
    });
    
    if (input) {
      input.addEventListener('change', function() {
        handleFileUpload(area, this.files);
      });
    }
  });
}

function handleFileUpload(area, files) {
  let preview = area.querySelector('.upload-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.className = 'upload-preview';
    preview.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
    area.appendChild(preview);
  }
  
  Array.from(files).forEach(file => {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = function(e) {
        const thumb = document.createElement('div');
        thumb.style.cssText = 'width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid var(--line-2);position:relative;';
        thumb.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;">`;
        preview.appendChild(thumb);
      };
      reader.readAsDataURL(file);
    }
  });
  
  showToast(`已上传 ${files.length} 个文件`, 'success');
}

// Generate animation - image studios
function startImageGeneration(count, onComplete) {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  previewContent.innerHTML = `
    <div class="preview-generating fade-in">
      <div class="generating-animation">
        <div class="gen-ring"></div>
        <div class="gen-ring"></div>
        <div class="gen-ring"></div>
        <div class="gen-center-icon">✨</div>
      </div>
      <div class="generating-text">
        <h3>AI 正在创作中...</h3>
        <p>正在生成 ${count} 张图片，请稍候</p>
        <div class="progress-bar">
          <div class="progress-fill" id="genProgress" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="progressText">准备中...</div>
      </div>
    </div>
  `;
  
  const progressBar = document.getElementById('genProgress');
  const progressText = document.getElementById('progressText');
  let progress = 0;
  
  const stages = [
    { at: 15, text: '分析需求参数...' },
    { at: 30, text: '生成场景提示词...' },
    { at: 45, text: 'AI 绘制中 (1/' + count + ')...' },
    { at: 65, text: 'AI 绘制中 (' + Math.ceil(count/2) + '/' + count + ')...' },
    { at: 85, text: '后期优化中...' },
    { at: 95, text: '即将完成...' },
  ];
  
  let stageIndex = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 3 + 1;
    if (progress > 99) progress = 99;
    
    progressBar.style.width = progress + '%';
    
    while (stageIndex < stages.length && progress >= stages[stageIndex].at) {
      progressText.textContent = stages[stageIndex].text;
      stageIndex++;
    }
    
    if (progress >= 99) {
      clearInterval(interval);
    }
  }, 150);
  
  // Simulate completion
  setTimeout(() => {
    clearInterval(interval);
    progressBar.style.width = '100%';
    progressText.textContent = '生成完成！';
    setTimeout(() => {
      if (onComplete) onComplete();
    }, 400);
  }, 4500 + count * 300);
}

// Generate animation - text studios
function startTextGeneration(onComplete) {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  previewContent.innerHTML = `
    <div class="preview-generating fade-in">
      <div class="generating-animation">
        <div class="gen-ring"></div>
        <div class="gen-ring"></div>
        <div class="gen-ring"></div>
        <div class="gen-center-icon">✍️</div>
      </div>
      <div class="generating-text">
        <h3>AI 正在创作中...</h3>
        <p>正在构思优质文案，请稍候</p>
        <div class="progress-bar">
          <div class="progress-fill" id="genProgress" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="progressText">准备中...</div>
      </div>
    </div>
  `;
  
  const progressBar = document.getElementById('genProgress');
  const progressText = document.getElementById('progressText');
  let progress = 0;
  
  const stages = [
    { at: 15, text: '理解主题需求...' },
    { at: 35, text: '构思内容结构...' },
    { at: 60, text: '生成文案内容...' },
    { at: 85, text: '优化润色中...' },
    { at: 95, text: '即将完成...' },
  ];
  
  let stageIndex = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 4 + 1.5;
    if (progress > 99) progress = 99;
    
    progressBar.style.width = progress + '%';
    
    while (stageIndex < stages.length && progress >= stages[stageIndex].at) {
      progressText.textContent = stages[stageIndex].text;
      stageIndex++;
    }
    
    if (progress >= 99) {
      clearInterval(interval);
    }
  }, 120);
  
  setTimeout(() => {
    clearInterval(interval);
    progressBar.style.width = '100%';
    progressText.textContent = '生成完成！';
    setTimeout(() => {
      if (onComplete) onComplete();
    }, 400);
  }, 3500);
}

// Image result generator (placeholder images) - cream style palettes
const creamPalettes = [
  ['#FDF0E0', '#F5E0C9'],
  ['#F5E6D3', '#E8D4BC'],
  ['#FAF0E3', '#F0DFC8'],
  ['#FCE8D5', '#F5D4B8'],
  ['#FFF4E6', '#F9E4CC'],
  ['#F7E8D3', '#EDD7BB'],
  ['#FEF0DB', '#F7DEBC'],
  ['#FBEBD6', '#F0D8BA'],
];

function generateImageResults(count, images) {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  const icons = ['🛍️', '👗', '💄', '🍵', '🏡', '📱', '⌚', '👟', '🎒', '💎', '🧴', '🫖', '🎧', '📷', '💻', '🪴', '🕯️', '🧸', '🎨', '🌸'];
  
  let html = '<div class="results-grid fade-in">';
  for (let i = 0; i < count; i++) {
    const icon = icons[i % icons.length];
    const palette = creamPalettes[i % creamPalettes.length];
    const imgUrl = images && images[i] ? images[i] : null;
    
    const innerContent = imgUrl 
      ? `<img src="${imgUrl}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="Generated image ${i+1}" onerror="this.style.display='none';this.parentElement.querySelector('.fallback-icon').style.display='flex';">
         <span class="fallback-icon" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;font-size:48px;">${icon}</span>`
      : `<span>${icon}</span>
         <span class="result-num">#${i+1}</span>`;
    
    html += `
      <div class="result-item" onclick="showToast('图片 ${i+1} - 点击查看大图','info')">
        <div class="result-placeholder" style="background: linear-gradient(135deg, ${palette[0]}, ${palette[1]}); position:relative;">
          ${innerContent}
        </div>
      </div>
    `;
  }
  html += '</div>';
  
  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.innerHTML = html;
}

// Sample text results for copywriting
const sampleCopies = [
  {
    title: '版本一 · 情感共鸣型',
    content: '每个精致的清晨，都值得被温柔以待。这款产品不仅仅是日常用品，更是你生活态度的体现。精选材质，匠心工艺，让每一次使用都成为仪式感满满的小确幸。懂生活的人，从不将就。',
    tags: ['情感共鸣', '精致生活', '仪式感']
  },
  {
    title: '版本二 · 痛点解决型',
    content: '还在为选择困难而烦恼？我们来帮你做决定！这款产品直击三大痛点：① 性价比低？不存在的，同款品质我们价格更优；② 质量堪忧？严格品控，售后无忧；③ 颜值不够？设计师倾力打造，好看又好用。',
    tags: ['痛点型', '理性说服', '对比优势']
  },
  {
    title: '版本三 · 种草安利型',
    content: '姐妹们！！！这个真的绝了好吗😭 我回购N次的宝藏好物，今天必须分享给你们！用了之后才发现以前的日子都白过了...不夸张地说，它已经成为我生活中不可或缺的一部分。相信我，买它你不会后悔的！💯',
    tags: ['种草型', '口语化', '强推荐']
  }
];

const sampleXhsNotes = [
  {
    title: '绝绝子！这个宝藏我怎么才发现啊😭',
    content: '家人们谁懂啊！！！今天给大家安利一个我最近挖到的宝，真的相见恨晚那种！\n\n✨ 颜值超高，放在哪里都是风景线\n✨ 性价比绝了，学生党也能冲\n✨ 用了一周效果肉眼可见\n\n我已经推荐给身边所有朋友了，用过的都说好！墙裂建议姐妹们人手一个～\n\n#好物分享 #宝藏推荐 #亲测有效',
    tags: ['#好物分享', '#宝藏推荐', '#亲测有效']
  },
  {
    title: '用了3个月，来说句公道话',
    content: '跟风入的，本来没抱太大期望，结果用了3个月之后...我错了，我应该早点买的！\n\n📌 使用感受：\n1️⃣ 质地非常舒服，完全不刺激\n2️⃣ 效果是循序渐进的那种，很安心\n3️⃣ 包装也很用心，送人超有面儿\n\n总结：如果你在犹豫，别犹豫了，真的值！\n\n#真实测评 #干货分享 #良心推荐',
    tags: ['#真实测评', '#干货分享', '#良心推荐']
  },
  {
    title: '别再乱买了！选对这一个就够了',
    content: '踩过无数坑之后，终于找到了我的本命款😭\n\n之前跟风买过好多，要么没用要么踩雷，这次真的选对了！\n\n💡 为什么选它：\n• 成分安全，敏感肌也能用\n• 效果看得见，不是智商税\n• 价格亲民，长期用也不心疼\n\n真心建议姐妹们试试，不会让你失望的～\n\n#避坑指南 #经验分享 #好物推荐',
    tags: ['#避坑指南', '#经验分享', '#好物推荐']
  }
];

const samplePosters = [
  { icon: '🎪', title: '方案一 · 节日促销风', desc: '热烈喜庆，突出折扣信息' },
  { icon: '🎨', title: '方案二 · 简约高级风', desc: '留白设计，突出品牌质感' },
  { icon: '🌈', title: '方案三 · 活力潮流风', desc: '年轻动感，适合新品发布' },
  { icon: '🏮', title: '方案四 · 传统国潮风', desc: '东方韵味，文化感十足' },
];

function generateCopyResults() {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  let html = '<div class="results-grid fade-in">';
  sampleCopies.forEach((item, i) => {
    const tagsHtml = item.tags.map(t => `<span class="result-tag">${t}</span>`).join('');
    html += `
      <div class="result-item result-text-card">
        <h4>${item.title}</h4>
        <div class="result-meta">AI生成 · 约${item.content.length}字</div>
        <div class="result-content">${item.content}</div>
        <div class="result-tags">${tagsHtml}</div>
      </div>
    `;
  });
  html += '</div>';
  
  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.innerHTML = html;
}

function generateXhsResults() {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  let html = '<div class="results-grid fade-in">';
  sampleXhsNotes.forEach((item, i) => {
    const tagsHtml = item.tags.map(t => `<span class="result-tag">${t}</span>`).join('');
    html += `
      <div class="result-item result-text-card">
        <h4>${item.title}</h4>
        <div class="result-meta">小红书笔记 · 约${item.content.length}字</div>
        <div class="result-content">${item.content.replace(/\n/g, '<br>')}</div>
        <div class="result-tags">${tagsHtml}</div>
      </div>
    `;
  });
  html += '</div>';
  
  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.innerHTML = html;
}

function generatePosterResults() {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  
  const posterPalettes = [
    ['#FDF0E0', '#F5D4B8'],
    ['#F5E6D3', '#E8C4A0'],
    ['#FAF0E3', '#F0DFC8'],
    ['#FCE8D5', '#E8C4A0'],
  ];
  
  let html = '<div class="results-grid fade-in">';
  samplePosters.forEach((item, i) => {
    const palette = posterPalettes[i % posterPalettes.length];
    html += `
      <div class="result-item" style="aspect-ratio: 3/4;" onclick="showToast('海报方案 ${i+1} - 点击查看大图','info')">
        <div class="result-placeholder" style="background: linear-gradient(135deg, ${palette[0]}, ${palette[1]}); flex-direction:column; gap:14px; padding:24px; text-align:center;">
          <span style="font-size:52px;">${item.icon}</span>
          <div style="font-size:14px; font-weight:600; color:var(--text);">${item.title}</div>
          <div style="font-size:12px; color:var(--text-2);">${item.desc}</div>
        </div>
      </div>
    `;
  });
  html += '</div>';
  
  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.innerHTML = html;
}

// Initialize common components
function initCommonComponents() {
  setupToggles();
  setupOptionGroups();
  setupColorPalettes();
  setupSliders();
  setupCollapsibleSections();
  setupTagInputs();
  setupSteppers();
  setupUploads();
}

// Update cost (to be overridden per page)
function updateCost() {
  // Base implementation, override per studio page
}


// ===== Real API result display helpers =====

function displayTextResults(versions, typeLabel) {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;

  const grid = document.createElement('div');
  grid.className = 'results-grid fade-in';
  versions.forEach((item, i) => {
    const content = String(item.content || '');
    const card = document.createElement('div');
    const title = document.createElement('h4');
    const meta = document.createElement('div');
    const body = document.createElement('div');
    const tags = document.createElement('div');

    card.className = 'result-item result-text-card';
    title.textContent = item.title || '版本 ' + (i + 1);
    meta.className = 'result-meta';
    meta.textContent = `${typeLabel || 'AI生成'} · 约${content.length}字`;
    body.className = 'result-content';
    body.textContent = content;
    body.style.whiteSpace = 'pre-wrap';
    tags.className = 'result-tags';
    (Array.isArray(item.tags) ? item.tags : []).forEach(value => {
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = String(value);
      tags.appendChild(tag);
    });

    card.append(title, meta, body, tags);
    grid.appendChild(card);
  });

  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.replaceChildren(grid);
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMediaUrl(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/uploads/') && !/["'<>\\]/.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (/^blob:[a-z0-9:/._-]+$/i.test(value)) return value;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (e) {
    return null;
  }
}

function displayImageResults(images, options) {
  const previewContent = document.querySelector('.preview-content');
  if (!previewContent) return;
  options = options || {};
  images = (Array.isArray(images) ? images : []).map(normalizeMediaUrl).filter(Boolean);
  const studioType = options.studio_type || 'ecommerce';
  const params = options.params || {};
  const regenerateFn = options.regenerate_fn || null;

  let html = `<div class="results-header fade-in">
    <div class="results-header-info">
      <h3 style="font-size:16px;font-weight:600;">生成完成 ✨</h3>
      <p style="font-size:12.5px;color:var(--text-3);margin-top:2px;">共 ${images.length} 张图片，点击可放大查看</p>
    </div>
    <div class="results-header-actions">
      ${regenerateFn ? `<button class="action-btn" onclick="__regen()">🔄 重新生成</button>` : ''}
      <button class="action-btn" onclick="__batchDl()">📥 全部下载</button>
      ${options.has_editor ? `<button class="action-btn primary" onclick="__openEditor()">✏️ 批量编辑</button>` : ''}
      ${options.save_template !== false ? `<button class="action-btn" onclick="__saveTpl()">💾 保存模板</button>` : ''}
    </div>
  </div>`;
  html += '<div class="results-grid fade-in">';
  images.forEach((img, i) => {
    const safeImg = escapeHtmlAttribute(img);
    html += `
      <div class="result-item result-image-item" style="aspect-ratio: 1/1;" onclick="__openLb(${i})">
        <img src="${safeImg}" alt="生成结果 ${i+1}" style="width:100%;height:100%;object-fit:cover;border-radius:12px;" loading="lazy">
        <div class="result-item-overlay">
          <div class="result-item-badge">#${i+1}</div>
          <div class="result-item-actions">
            <button class="result-item-btn" onclick="event.stopPropagation();__regenOne(${i})" title="基于这张重新生成">🔄</button>
            <button class="result-item-btn" onclick="event.stopPropagation();__dlOne(${i})" title="下载">📥</button>
          </div>
        </div>
      </div>
    `;
  });
  html += '</div>';

  previewContent.style.display = "block";
  previewContent.style.alignItems = "stretch";
  previewContent.style.justifyContent = "flex-start";
  previewContent.style.padding = '24px';
  previewContent.innerHTML = html;

  // 绑定全局函数
  window.__openLb = function(idx) { openImageLightbox(images, idx); };
  window.__batchDl = function() { batchDownload(images, studioType); };
  window.__dlOne = function(idx) {
    const a = document.createElement('a');
    a.href = images[idx];
    a.download = `${studioType}-${idx+1}.png`;
    a.target = '_blank';
    document.body.appendChild(a); a.click(); a.remove();
  };
  window.__openEditor = function() {
    const encoded = images.map(encodeURIComponent).join(',');
    window.open(`editor.html?v=17&imgs=${encoded}&studio=${studioType}`, '_blank');
  };
  window.__regen = function() {
    if (regenerateFn) regenerateFn(params, 'all');
  };
  window.__regenOne = function(idx) {
    if (regenerateFn) regenerateFn(params, 'variation', images[idx]);
  };
  window.__saveTpl = function() {
    showSaveTemplateDialog(studioType, params, () => {
      showToast('模板保存成功，下次可直接套用', 'success');
    });
  };
}

// Poll generation task status without overlapping requests
function pollGeneration(taskId, onSuccess, onFail, maxPolls) {
  maxPolls = maxPolls || 60;
  let pollCount = 0;
  let timer = null;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  async function poll() {
    if (stopped) return;
    pollCount++;
    if (pollCount > maxPolls) {
      stop();
      if (onFail) onFail('timeout');
      return;
    }

    try {
      const statusData = await apiRequest('/api/generation/' + taskId);
      if (stopped) return;
      if (statusData.code !== 0) {
        stop();
        if (onFail) onFail(statusData.msg || '任务状态查询失败');
        return;
      }
      if (statusData.data.status === 'success') {
        stop();
        if (onSuccess) onSuccess(statusData.data);
        return;
      }
      if (statusData.data.status === 'failed') {
        stop();
        if (onFail) onFail(statusData.data.error_msg || '生成失败');
        return;
      }
      timer = setTimeout(poll, 3000);
    } catch (error) {
      stop();
      if (onFail) onFail(error.message || '任务状态查询失败');
    }
  }

  timer = setTimeout(poll, 3000);
  return { stop };
}

// ===== 结果页灯箱 (图片预览 + 左右切换) =====
function openImageLightbox(images, startIndex) {
  if (!images || images.length === 0) return;
  let cur = startIndex || 0;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:flex;align-items:center;justify-content:center;';
  lb.innerHTML = `
    <button style="position:absolute;top:20px;right:20px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;" class="lb-close">×</button>
    <button style="position:absolute;left:24px;top:50%;transform:translateY(-50%);width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;" class="lb-prev">‹</button>
    <img src="${escapeHtmlAttribute(normalizeMediaUrl(images[cur]) || '')}" style="max-width:90%;max-height:90%;border-radius:8px;object-fit:contain;" alt="">
    <button style="position:absolute;right:24px;top:50%;transform:translateY(-50%);width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;" class="lb-next">›</button>
    <div style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.8);font-size:13px;" class="lb-counter"></div>
    <button style="position:absolute;bottom:24px;right:24px;padding:10px 18px;background:rgba(255,255,255,0.15);color:#fff;border:none;border-radius:10px;font-size:13px;cursor:pointer;" class="lb-download">📥 下载</button>
  `;
  const img = lb.querySelector('img');
  const counter = lb.querySelector('.lb-counter');

  function update() {
    img.src = images[cur];
    counter.textContent = `${cur + 1} / ${images.length}`;
  }
  update();

  lb.querySelector('.lb-close').onclick = () => { lb.remove(); document.onkeydown = null; };
  lb.querySelector('.lb-prev').onclick = (e) => { e.stopPropagation(); cur = (cur - 1 + images.length) % images.length; update(); };
  lb.querySelector('.lb-next').onclick = (e) => { e.stopPropagation(); cur = (cur + 1) % images.length; update(); };
  lb.querySelector('.lb-download').onclick = (e) => {
    e.stopPropagation();
    const a = document.createElement('a');
    a.href = images[cur];
    a.download = `ai-studio-${cur + 1}.png`;
    a.target = '_blank';
    document.body.appendChild(a); a.click(); a.remove();
  };
  lb.onclick = (e) => { if (e.target === lb) { lb.remove(); document.onkeydown = null; } };
  document.onkeydown = (e) => {
    if (e.key === 'Escape') { lb.remove(); document.onkeydown = null; }
    if (e.key === 'ArrowLeft') { cur = (cur - 1 + images.length) % images.length; update(); }
    if (e.key === 'ArrowRight') { cur = (cur + 1) % images.length; update(); }
  };
  document.body.appendChild(lb);
}

// ===== 保存参数模板弹窗 =====
function showSaveTemplateDialog(studioType, params, onSaved) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;width:400px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2);">
      <h3 style="font-size:17px;font-weight:600;margin-bottom:16px;color:var(--text);">💾 保存为模板</h3>
      <p style="font-size:13px;color:var(--text-2);margin-bottom:16px;">给这套参数起个名字，下次可以直接套用</p>
      <input type="text" id="tplNameInput" class="form-input" placeholder="请输入模板名称，如：618大促风格" maxlength="30" style="width:100%;margin-bottom:16px;">
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="action-btn" id="tplCancel">取消</button>
        <button class="action-btn primary" id="tplSave">保存</button>
      </div>
    </div>
  `;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.querySelector('#tplCancel').onclick = () => modal.remove();
  modal.querySelector('#tplSave').onclick = async () => {
    const name = modal.querySelector('#tplNameInput').value.trim();
    if (!name) { showToast('请输入模板名称', 'error'); return; }
    const res = await apiRequest('/api/user/templates', {
      method: 'POST',
      body: JSON.stringify({ name, studio_type: studioType, params })
    });
    if (res.code === 0) {
      showToast('模板已保存', 'success');
      modal.remove();
      if (onSaved) onSaved(res.data);
    } else {
      showToast(res.msg, 'error');
    }
  };
  document.body.appendChild(modal);
  setTimeout(() => modal.querySelector('#tplNameInput').focus(), 50);
}

// ===== 加载模板列表 (用于回填表单) =====
async function loadTemplates(studioType) {
  const res = await apiRequest('/api/user/templates?studio=' + studioType);
  if (res.code === 0) return res.data;
  return [];
}

function renderTemplateList(container, templates, onSelect) {
  container.replaceChildren();
  (Array.isArray(templates) ? templates : []).forEach(template => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;transition:all 0.2s;';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const name = document.createElement('div');
    name.style.cssText = 'font-size:14px;font-weight:500;color:var(--text);';
    name.textContent = String(template.name || '未命名模板');

    const createdAt = document.createElement('div');
    createdAt.style.cssText = 'font-size:11.5px;color:var(--text-3);margin-top:3px;';
    const date = new Date(template.created_at);
    createdAt.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();

    const select = () => { if (onSelect) onSelect(template); };
    item.addEventListener('click', select);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    item.addEventListener('mouseenter', () => { item.style.borderColor = 'var(--brand)'; });
    item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border)'; });
    item.append(name, createdAt);
    container.appendChild(item);
  });
}

// ===== 批量下载 =====
function batchDownload(images, prefix) {
  if (!images || images.length === 0) return;
  images.forEach((url, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${prefix || 'ai-studio'}-${i + 1}.png`;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, i * 500);
  });
  showToast(`已开始下载 ${images.length} 张图片`, 'success');
}
