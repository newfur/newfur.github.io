// reader/parsers/epub-parser.js
// EPUB 電子書解析器，使用 JSZip 解壓並重構章節與資源

import { getMsg } from '../i18n.js';

export class EpubParser {
  constructor(fileBlob) {
    this.fileBlob = fileBlob;
    this.zip = null;
    this.opfPath = '';
    this.opfDir = '';
    this.metadata = {};
    this.manifest = {}; // id -> { href, mediaType }
    this.spine = [];    // list of manifest ids in reading order
    this.chapters = []; // list of processed chapters: { title, href, content }
    this.cover = null;
    this.resourceUrls = [];
  }

  // 主解析函數
  async parse() {
    // 1. 加載 JSZip 并解壓
    this.zip = await JSZip.loadAsync(this.fileBlob);
    
    // 2. 獲取 opf 檔案路徑
    this.opfPath = await this._getOpfPath();
    this.opfDir = this._getDirectory(this.opfPath);

    // 3. 讀取並解析 OPF 檔案
    const opfText = await this.zip.file(this.opfPath).async('string');
    this._parseOpf(opfText);

    // 4. 解析封面圖 (Blob)
    this.cover = await this._getCoverUrl();

    // 5. 解析目錄 (TOC)
    const tocChapters = await this._parseTOC();
    
    // 6. 找出所有在 spine 中但沒有出現在目錄 (TOC) 中的文件路徑，將其作為追加章節放入，防止導航及進度讀取錯誤
    const tocCleanHrefs = new Set(tocChapters.map(ch => ch.cleanHref));
    
    // 建立 spineHrefs 映射以供排序和標題繼承
    const spineHrefs = this.spine.map(id => {
      const item = this.manifest[id];
      return item ? item.href : null;
    }).filter(Boolean);

    this.spine.forEach(idref => {
      const item = this.manifest[idref];
      if (item && item.href && !tocCleanHrefs.has(item.href)) {
        tocChapters.push({
          title: getMsg('notes_chapter_title') || 'Notes/Appendix',
          href: item.href,
          hash: '',
          cleanHref: item.href,
          hiddenFromTOC: true,
          getContent: async () => this.loadChapterContent(item.href)
        });
        tocCleanHrefs.add(item.href);
      }
    });

    // 7. 依照 spine 順序進行排序，確保閱讀順序完全符合書籍的線性結構
    tocChapters.sort((a, b) => {
      const idxA = spineHrefs.indexOf(a.cleanHref);
      const idxB = spineHrefs.indexOf(b.cleanHref);
      return idxA - idxB;
    });

    // 8. 對於隱藏章節，繼承前一個章節的標題，使其在頂部標題列中顯示更自然
    for (let i = 0; i < tocChapters.length; i++) {
      if (tocChapters[i].hiddenFromTOC) {
        if (i > 0) {
          tocChapters[i].title = tocChapters[i - 1].title;
        } else {
          tocChapters[i].title = this.metadata.title || 'Start';
        }
      }
    }
    
    return {
      metadata: {
        title: this.metadata.title || 'Unknown EPUB',
        author: this.metadata.author || 'Unknown Author',
        cover: this.cover,
        size: this.fileBlob.size
      },
      chapters: tocChapters, // { title, href, contentFetcher }
      manifest: this.manifest,
      opfDir: this.opfDir,
      zip: this.zip
    };
  }

  // 獲取 .opf 文件路徑
  async _getOpfPath() {
    const containerFile = this.zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Invalid EPUB: Missing container.xml');
    
    const containerText = await containerFile.async('string');
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(containerText, 'text/xml');
    const rootfileNode = xmlDoc.querySelector('rootfile');
    
    if (!rootfileNode) throw new Error('Invalid EPUB: No rootfile node found');
    return rootfileNode.getAttribute('full-path');
  }

  // 獲取路徑的文件夾部分
  _getDirectory(filePath) {
    const parts = filePath.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  }

  // 解析 OPF
  _parseOpf(opfText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(opfText, 'text/xml');

    // 解析元數據 (Metadata)
    const titleNode = xmlDoc.querySelector('metadata > title') || xmlDoc.querySelector('title');
    const creatorNode = xmlDoc.querySelector('metadata > creator') || xmlDoc.querySelector('creator');
    this.metadata.title = titleNode ? titleNode.textContent.trim() : '';
    this.metadata.author = creatorNode ? creatorNode.textContent.trim() : '';

    // 解析清單 (Manifest)
    const itemNodes = xmlDoc.querySelectorAll('manifest > item');
    itemNodes.forEach(node => {
      const id = node.getAttribute('id');
      const href = node.getAttribute('href');
      const mediaType = node.getAttribute('media-type');
      const properties = node.getAttribute('properties') || '';
      
      this.manifest[id] = {
        href: this._resolvePath(this.opfDir, href),
        mediaType,
        properties
      };
    });

    // 解析脊骨 (Spine)
    const itemrefNodes = xmlDoc.querySelectorAll('spine > itemref');
    itemrefNodes.forEach(node => {
      const idref = node.getAttribute('idref');
      this.spine.push(idref);
    });
  }

  // 解析相對路徑 (支援 hash 解析)
  _resolvePath(baseDir, relativePath) {
    const [pathPart, hashPart] = relativePath.split('#');
    // 移除 relativePath 中的 ../ 等路徑，計算出最終的絕對 zip 路徑
    const absolute = baseDir + pathPart;
    const parts = absolute.split('/');
    const result = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        result.pop();
      } else {
        result.push(part);
      }
    }
    const resolvedPath = result.join('/');
    return hashPart !== undefined ? `${resolvedPath}#${hashPart}` : resolvedPath;
  }

  // 獲取封面圖 URL
  async _getCoverUrl() {
    try {
      // 方法 A：尋找 properties="cover-image" 的 item
      let coverItemId = Object.keys(this.manifest).find(
        id => this.manifest[id].properties.includes('cover-image')
      );

      // 方法 B：尋找 metadata 中的 name="cover" 的 meta 標籤
      if (!coverItemId) {
        // 在 OPF 中搜尋 meta
        const opfText = await this.zip.file(this.opfPath).async('string');
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(opfText, 'text/xml');
        const coverMeta = xmlDoc.querySelector('metadata > meta[name="cover"]');
        if (coverMeta) {
          coverItemId = coverMeta.getAttribute('content');
        }
      }

      // 方法 C：退而求其次尋找包含 cover 關鍵字且為圖片的 manifest item
      if (!coverItemId) {
        coverItemId = Object.keys(this.manifest).find(
          id => id.toLowerCase().includes('cover') && this.manifest[id].mediaType.startsWith('image/')
        );
      }

      if (coverItemId && this.manifest[coverItemId]) {
        const coverItem = this.manifest[coverItemId];
        const coverFile = this.zip.file(coverItem.href);
        if (coverFile) {
          const blob = await coverFile.async('blob');
          return blob;
        }
      }
    } catch (e) {
      console.warn('Failed to parse cover image:', e);
    }
    return null; // 默認返回 null，後續使用占位封面
  }
  // 解析 TOC 目錄
  async _parseTOC() {
    // EPUB 3 使用 navigation document (通常在 manifest 中屬性含有 'nav')
    // EPUB 2 使用 ncx 檔案 (通常是 media-type = 'application/x-dtbncx+xml')
    let navItem = Object.values(this.manifest).find(item => item.properties && item.properties.includes('nav'));
    if (!navItem) {
      // 容錯降級：尋找 id 或 href 中含有 nav 或 toc 關鍵字的文件
      navItem = Object.entries(this.manifest).find(([id, item]) => 
        id.toLowerCase().includes('nav') || 
        id.toLowerCase().includes('toc') || 
        (item.href && (item.href.toLowerCase().includes('nav.xhtml') || item.href.toLowerCase().includes('toc.xhtml') || item.href.toLowerCase().includes('nav.html') || item.href.toLowerCase().includes('toc.html')))
      )?.[1];
    }

    let ncxItem = Object.values(this.manifest).find(item => item.mediaType === 'application/x-dtbncx+xml');
    if (!ncxItem) {
      // 容錯降級：尋找 id 或 href 含有 ncx 關鍵字的文件
      ncxItem = Object.entries(this.manifest).find(([id, item]) => 
        id.toLowerCase().includes('ncx') || 
        (item.href && item.href.toLowerCase().includes('.ncx'))
      )?.[1];
    }

    const tocList = [];

    if (navItem) {
      try {
        let navText = await this.zip.file(navItem.href).async('string');
        // Fix self-closing script tags that break DOMParser in text/html mode
        navText = navText.replace(/<script([^>]*?)\/>/gi, '<script$1><\/script>');
        const parser = new DOMParser();
        const doc = parser.parseFromString(navText, 'text/html');
        let navLinks = doc.querySelectorAll('nav a');
        if (navLinks.length === 0) {
          navLinks = doc.querySelectorAll('a'); // 容錯：若無 nav 標籤，獲取所有連結
        }
        
        navLinks.forEach(link => {
          const hrefAttr = link.getAttribute('href');
          if (!hrefAttr) return;
          const title = link.textContent.trim();
          // navItem.href 的資料夾部分作為 resolved href 的 base
          const baseDir = this._getDirectory(navItem.href);
          const resolvedHref = this._resolvePath(baseDir, hrefAttr);
          
          // 計算 depth: 向上尋找導航節點中的 ol/ul 父節點個數
          let depth = 0;
          let parent = link.parentElement;
          while (parent && parent.tagName.toLowerCase() !== 'nav' && parent.tagName.toLowerCase() !== 'body' && parent.tagName.toLowerCase() !== 'html') {
            const tagName = parent.tagName.toLowerCase();
            if (tagName === 'ol' || tagName === 'ul') {
              depth++;
            }
            parent = parent.parentElement;
          }
          const finalDepth = Math.max(0, depth - 1);
          tocList.push({ title, href: resolvedHref, depth: finalDepth });
        });
      } catch (e) {
        console.warn('EPUB 3 nav parsing failed, falling back to Ncx:', e);
      }
    }

    if (tocList.length === 0 && ncxItem) {
      try {
        const ncxText = await this.zip.file(ncxItem.href).async('string');
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(ncxText, 'text/xml');
        
        // 容錯：XML 區分大小寫，支持 navPoint 和 navpoint
        let navPoints = xmlDoc.querySelectorAll('navPoint');
        if (navPoints.length === 0) {
          navPoints = xmlDoc.querySelectorAll('navpoint');
        }
        
        navPoints.forEach(point => {
          // 容錯：支持 navLabel 和 navlabel，以及直接取節點內容
          let labelNode = point.querySelector('navLabel > text') || 
                            point.querySelector('navlabel > text') || 
                            point.querySelector('navLabel text') || 
                            point.querySelector('navlabel text');
          if (!labelNode) {
            labelNode = point.querySelector('navLabel') || point.querySelector('navlabel');
          }
          
          const contentNode = point.querySelector('content');
          if (labelNode && contentNode) {
            const title = labelNode.textContent.trim();
            const src = contentNode.getAttribute('src');
            const baseDir = this._getDirectory(ncxItem.href);
            const resolvedHref = this._resolvePath(baseDir, src);
            
            // 計算 depth: 向上尋找 navPoint/navpoint 父節點個數
            let depth = 0;
            let parent = point.parentElement;
            while (parent) {
              const pTagName = parent.tagName ? parent.tagName.toLowerCase() : '';
              if (pTagName === 'navpoint') {
                depth++;
              }
              parent = parent.parentElement;
            }
            tocList.push({ title, href: resolvedHref, depth: depth });
          }
        });
      } catch (e) {
        console.warn('EPUB 2 NCX parsing failed:', e);
      }
    }

    // 如果沒有目錄，就直接使用 Spine 中的文件作為章節
    if (tocList.length === 0) {
      this.spine.forEach((id, index) => {
        const item = this.manifest[id];
        if (item) {
          tocList.push({
            title: `Chapter ${index + 1}`,
            href: item.href
          });
        }
      });
    }

    // 為每個章節添加內容抓取函數
    return tocList.map(ch => {
      // 獲取對應章節的絕對路徑（除去 hash）
      const [cleanHref, hash] = ch.href.split('#');
      return {
        title: ch.title,
        href: ch.href,
        hash: hash || '',
        cleanHref: cleanHref,
        depth: ch.depth || 0,
        getContent: async () => this.loadChapterContent(cleanHref)
      };
    });
  }

  // 讀取某個章節內容並替換資源引用為 Object URL
  async loadChapterContent(cleanHref) {
    if (!this.resourceUrls) {
      this.resourceUrls = [];
    }

    const file = this.zip.file(cleanHref);
    if (!file) return `<p style="color:red;">Error: Chapter file not found (${cleanHref})</p>`;
    
    let htmlText = await file.async('string');
    // Fix self-closing script tags that break DOMParser in text/html mode
    htmlText = htmlText.replace(/<script([^>]*?)\/>/gi, '<script$1><\/script>');
    
    // 解析 DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    const baseDir = this._getDirectory(cleanHref);

    // 1. 替換圖片 src
    const images = doc.querySelectorAll('img, image');
    for (const img of images) {
      const srcAttr = img.getAttribute('src') || img.getAttribute('xlink:href') || img.getAttribute('href');
      if (srcAttr && !srcAttr.startsWith('data:') && !srcAttr.startsWith('http')) {
        const absoluteImgPath = this._resolvePath(baseDir, srcAttr);
        const imgFile = this.zip.file(absoluteImgPath);
        if (imgFile) {
          try {
            const imgBlob = await imgFile.async('blob');
            const imgUrl = URL.createObjectURL(imgBlob);
            this.resourceUrls.push(imgUrl);
            if (img.tagName.toLowerCase() === 'image') {
              img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imgUrl);
              img.setAttribute('href', imgUrl);
              img.setAttribute('xlink:href', imgUrl);
            } else {
              img.setAttribute('src', imgUrl);
            }
          } catch (e) {
            console.error('Failed to load image:', absoluteImgPath, e);
          }
        }
      }
    }

    // 2. 處理 CSS 樣式表 (進行 CSS 隔離，防止書籍樣式污染全域 body/html)
    const stylesheets = doc.querySelectorAll('link[rel="stylesheet"]');
    for (const link of stylesheets) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('data:') && !href.startsWith('http')) {
        const absoluteCssPath = this._resolvePath(baseDir, href);
        const cssFile = this.zip.file(absoluteCssPath);
        if (cssFile) {
          try {
            const cssText = await cssFile.async('string');
            const scopedCss = this._scopeCSS(cssText, '.book-content');
            const cssBlob = new Blob([scopedCss], { type: 'text/css' });
            const cssUrl = URL.createObjectURL(cssBlob);
            this.resourceUrls.push(cssUrl);
            link.setAttribute('href', cssUrl);
          } catch (e) {
            console.error('Failed to load stylesheet:', absoluteCssPath, e);
          }
        }
      }
    }

    // 3. 獲取主體內容
    const body = doc.querySelector('body');
    if (!body) return htmlText;

    // 將章節內部跳轉 a 標籤轉換為自定義跳轉事件或屬性
    const links = doc.querySelectorAll('a');
    links.forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('mailto')) {
        // 重寫內部跳轉為 data-epub-href
        let resolvedLink;
        if (href.startsWith('#')) {
          // 如果是純 hash 的內部跳轉，將其解析為相對於當前檔案本身的完整路徑，防止頁面內跳轉失效
          resolvedLink = cleanHref + href;
        } else {
          resolvedLink = this._resolvePath(baseDir, href);
        }
        a.setAttribute('data-epub-href', resolvedLink);
        a.removeAttribute('href'); // 移除 href 屬性以防止瀏覽器默認跳轉
        a.style.cursor = 'pointer';
        a.style.textDecoration = 'underline';
      }
    });

    // 提取並隔離所有樣式標籤 (link / style)，防止書籍內部樣式污染全域 body/html/div 等
    const styleElements = doc.querySelectorAll('link[rel="stylesheet"], style');
    let stylesHtml = '';
    styleElements.forEach(style => {
      if (style.tagName.toLowerCase() === 'style') {
        const cssText = style.textContent;
        const scopedCssText = this._scopeCSS(cssText, '.book-content');
        stylesHtml += `<style>${scopedCssText}</style>\n`;
        style.remove(); // 從 DOM 中移除，防止 body.innerHTML 中殘留未被隔離的原始樣式
      } else if (style.tagName.toLowerCase() === 'link') {
        stylesHtml += style.outerHTML + '\n';
        style.remove();
      }
    });

    return stylesHtml + body.innerHTML;
  }

  // CSS 隔離助手函數：利用狀態機解析 CSS，以便正確處理 @media/keyframes 嵌套大括號
  _scopeCSS(cssText, scopeSelector = '.book-content') {
    if (!cssText) return '';
    
    // 1. 移除註釋
    let cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // 2. 解析 CSS
    let result = '';
    let i = 0;
    const len = cleanCss.length;
    let buffer = '';
    let braceDepth = 0;
    let inKeyframes = false;
    let isGlobalLayoutSelector = false; // 記錄當前規則塊是否屬於 body / html / :root 選擇器
    
    while (i < len) {
      const char = cleanCss[i];
      
      if (char === '{') {
        braceDepth++;
        if (braceDepth === 1) {
          let selector = buffer.trim();
          buffer = '';
          
          // 判斷是否為全局排版選擇器
          const lowerSel = selector.toLowerCase();
          isGlobalLayoutSelector = (lowerSel === 'body' || lowerSel === 'html' || lowerSel === ':root' || 
                                    lowerSel.startsWith('body ') || lowerSel.startsWith('html ') || lowerSel.startsWith(':root '));
          
          if (selector.startsWith('@')) {
            result += selector + ' {';
            if (selector.toLowerCase().includes('keyframes')) {
              inKeyframes = true;
            }
          } else {
            const scopedSelector = this._scopeSelectorList(selector, scopeSelector);
            result += scopedSelector + ' {';
          }
        } else {
          let content = buffer.trim();
          buffer = '';
          if (braceDepth === 2 && !inKeyframes) {
            const lowerSel = content.toLowerCase();
            isGlobalLayoutSelector = (lowerSel === 'body' || lowerSel === 'html' || lowerSel === ':root' || 
                                      lowerSel.startsWith('body ') || lowerSel.startsWith('html ') || lowerSel.startsWith(':root '));
            
            const scopedSelector = this._scopeSelectorList(content, scopeSelector);
            result += scopedSelector + ' {';
          } else {
            result += content + ' {';
          }
        }
      } else if (char === '}') {
        braceDepth--;
        let rulesText = buffer.trim();
        
        // 如果是 body/html/:root 選擇器的規則塊，過濾掉 margin 和 padding 屬性，防範書籍重疊外邊距
        if (isGlobalLayoutSelector && rulesText) {
          rulesText = this._filterMarginsAndPaddings(rulesText);
        }
        
        result += rulesText + ' }';
        buffer = '';
        if (braceDepth === 0) {
          inKeyframes = false;
          isGlobalLayoutSelector = false;
        }
      } else {
        buffer += char;
      }
      i++;
    }
    
    result += buffer.trim();
    return result;
  }

  // 過濾掉規則文字中的 margin 與 padding 宣告
  _filterMarginsAndPaddings(rulesText) {
    return rulesText.split(';')
      .map(decl => {
        const trimmed = decl.trim();
        if (!trimmed) return '';
        
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) return decl;
        
        const propName = trimmed.substring(0, colonIdx).trim().toLowerCase();
        // 如果屬性是 margin 或 padding 相關的，丟棄它以防止疊加邊距
        if (propName.startsWith('margin') || propName.startsWith('padding')) {
          return '';
        }
        return decl;
      })
      .filter(Boolean)
      .join(';');
  }

  // 輔助函數：將選擇器列表（逗號分隔）中的每個選擇器進行 scope 化
  _scopeSelectorList(selectorList, scopeSelector) {
    return selectorList.split(',')
      .map(sel => {
        let trimmed = sel.trim();
        if (!trimmed) return '';
        
        const lower = trimmed.toLowerCase();
        if (lower === 'body' || lower === 'html' || lower === ':root') {
          return scopeSelector;
        }
        
        if (lower.startsWith('body ') || lower.startsWith('body.')) {
          return scopeSelector + trimmed.substring(4);
        }
        if (lower.startsWith('html ') || lower.startsWith('html.')) {
          return scopeSelector + trimmed.substring(4);
        }
        if (lower.startsWith(':root ') || lower.startsWith(':root.')) {
          return scopeSelector + trimmed.substring(5);
        }
        
        if (trimmed.includes(scopeSelector)) {
          return trimmed;
        }
        
        return `${scopeSelector} ${trimmed}`;
      })
      .filter(Boolean)
      .join(', ');
  }
}
