// reader/parsers/epub-parser.js
// EPUB 電子書解析器，使用 JSZip 解壓並重構章節與資源

import { getMsg } from '../i18n.js';
import { security } from '../security/sanitize.js';

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
        language: this.metadata.language || '',
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
    const titleNode = xmlDoc.querySelector('metadata > title') || xmlDoc.querySelector('title') || xmlDoc.getElementsByTagName('dc:title')[0] || xmlDoc.getElementsByTagName('title')[0];
    const creatorNode = xmlDoc.querySelector('metadata > creator') || xmlDoc.querySelector('creator') || xmlDoc.getElementsByTagName('dc:creator')[0] || xmlDoc.getElementsByTagName('creator')[0];
    const langNode = xmlDoc.querySelector('metadata > language') || xmlDoc.querySelector('language') || xmlDoc.getElementsByTagName('dc:language')[0] || xmlDoc.getElementsByTagName('language')[0];
    this.metadata.title = titleNode ? titleNode.textContent.trim() : '';
    this.metadata.author = creatorNode ? creatorNode.textContent.trim() : '';
    this.metadata.language = langNode ? langNode.textContent.trim() : '';

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
    let navItem = Object.values(this.manifest).find(item => item.properties && item.properties.includes('nav'));
    let ncxItem = Object.values(this.manifest).find(item => item.mediaType === 'application/x-dtbncx+xml');

    // 如果沒有標準的 nav 且沒有標準的 ncx，才進行容錯降級尋找可能的文件
    if (!navItem && !ncxItem) {
      navItem = Object.entries(this.manifest).find(([id, item]) => 
        id.toLowerCase().includes('nav') || 
        id.toLowerCase().includes('toc') || 
        (item.href && (item.href.toLowerCase().includes('nav.xhtml') || item.href.toLowerCase().includes('toc.xhtml') || item.href.toLowerCase().includes('nav.html') || item.href.toLowerCase().includes('toc.html')))
      )?.[1];

      if (!navItem) {
        ncxItem = Object.entries(this.manifest).find(([id, item]) => 
          id.toLowerCase().includes('ncx') || 
          (item.href && item.href.toLowerCase().includes('.ncx'))
        )?.[1];
      }
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
        
        // 容錯：XML 區分大小寫，支持 navPoint 和 navpoint，並忽略命名空間
        let navPoints = Array.from(xmlDoc.getElementsByTagNameNS('*', 'navPoint'));
        if (navPoints.length === 0) {
          navPoints = Array.from(xmlDoc.getElementsByTagNameNS('*', 'navpoint'));
        }
        if (navPoints.length === 0) {
          // 最後的退路，嘗試傳統方法
          navPoints = Array.from(xmlDoc.querySelectorAll('navPoint, navpoint'));
        }
        
        navPoints.forEach(point => {
          // 容錯：提取標題與內容節點，忽略命名空間
          const labels = Array.from(point.getElementsByTagNameNS('*', 'navLabel'));
          const labelsLower = Array.from(point.getElementsByTagNameNS('*', 'navlabel'));
          const allLabels = [...labels, ...labelsLower];
          let title = '';
          
          if (allLabels.length > 0) {
            // 取第一個 label（直接子級）的 text
            const firstLabel = allLabels[0];
            const texts = Array.from(firstLabel.getElementsByTagNameNS('*', 'text'));
            if (texts.length > 0) {
              title = texts[0].textContent.trim();
            } else {
              title = firstLabel.textContent.trim();
            }
          }
          
          const contents = Array.from(point.getElementsByTagNameNS('*', 'content'));
          const contentNode = contents.length > 0 ? contents[0] : null;
          
          if (title && contentNode) {
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

    const createErrorContent = (message) => {
      const paragraph = document.createElement('p');
      paragraph.style.color = 'red';
      paragraph.textContent = message;
      return security.sanitizeChapterHtml(paragraph.outerHTML);
    };

    const file = this.zip.file(cleanHref);
    if (!file) {
      return createErrorContent(`Error: Chapter file not found (${cleanHref})`);
    }
    
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
            security.trustResourceUrl(imgUrl);
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
    const localStyles = [];
    for (const link of stylesheets) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('data:') && !href.startsWith('http')) {
        const absoluteCssPath = this._resolvePath(baseDir, href);
        const cssFile = this.zip.file(absoluteCssPath);
        if (cssFile) {
          try {
            const cssText = await cssFile.async('string');
            localStyles.push(this._scopeCSS(cssText, '.book-content'));
          } catch (e) {
            console.error('Failed to load stylesheet:', absoluteCssPath, e);
          }
        }
      }
      link.remove();
    }

    // 3. 獲取主體內容
    const body = doc.querySelector('body');
    if (!body) return createErrorContent('Error: Invalid chapter document');

    // 將章節內部跳轉 a 標籤轉換為自定義跳轉事件或屬性
    const links = doc.querySelectorAll('a');
    links.forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('mailto')) {
        if (href.startsWith('#')) {
          a.style.cursor = 'pointer';
          a.style.textDecoration = 'underline';
          return;
        }
        // 重寫內部跳轉為 data-epub-href
        const resolvedLink = this._resolvePath(baseDir, href);
        a.setAttribute('data-epub-href', resolvedLink);
        a.removeAttribute('href'); // 移除 href 屬性以防止瀏覽器默認跳轉
        a.style.cursor = 'pointer';
        a.style.textDecoration = 'underline';
      }
    });

    // 提取並隔離所有樣式標籤 (link / style)，防止書籍內部樣式污染全域 body/html/div 等
    const styleElements = doc.querySelectorAll('style');
    let stylesHtml = '';
    localStyles.forEach((cssText) => {
      const style = document.createElement('style');
      style.textContent = cssText;
      stylesHtml += `${style.outerHTML}\n`;
    });
    styleElements.forEach(style => {
      const scopedStyle = document.createElement('style');
      scopedStyle.textContent = this._scopeCSS(style.textContent, '.book-content');
      stylesHtml += `${scopedStyle.outerHTML}\n`;
      style.remove(); // 從 DOM 中移除，防止 body.innerHTML 中殘留未被隔離的原始樣式
    });
    const finalContent = this._cleanMalformedTagFragments(stylesHtml + body.innerHTML);
    return security.sanitizeChapterHtml(finalContent);
  }

  // CSS 隔離助手函數：利用現代 CSS @scope 特性進行超快速隔離，大幅減少解析時間
  _scopeCSS(cssText, scopeSelector = '.book-content') {
    if (!cssText) return '';
    
    // 1. 移除註釋
    let cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // 2. 過濾針對 html/body/:root 原身聲明的 margin 和 padding，防止其干擾閱讀器本身的佈局設定
    let scoped = cleanCss.replace(/\b(html|body|:root)\b([^{]*)\{([^{}]+)\}/gi, (match, selector, suffix, rules) => {
      const isDescendant = /[\s>+~]/.test(suffix.trim());
      const filteredRules = rules.split(';')
        .map(decl => {
          const trimmed = decl.trim();
          if (!trimmed) return '';
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx === -1) return decl;
          const propName = trimmed.substring(0, colonIdx).trim().toLowerCase();
          if (!isDescendant && (propName.startsWith('margin') || propName.startsWith('padding'))) {
            return '';
          }
          return decl;
        })
        .filter(Boolean)
        .join(';');
      return `${scopeSelector}${suffix} { ${filteredRules} }`;
    });
    
    // 3. 將其他單獨出現的 html, body, :root 關鍵字替換為 scopeSelector
    scoped = scoped.replace(/\b(html|body|:root)\b/gi, scopeSelector);
    
    // 4. 用 CSS 原生 @scope 特性包裹進行最終隔離
    return `@scope (${scopeSelector}) {\n${scoped}\n}`;
  }

  _cleanMalformedTagFragments(html) {
    if (!html) return '';
    let cleaned = html.trim();

    // Whitelist of common tag names, their suffixes (length >= 2), and closing versions
    const knownTags = new Set([
      // Standard tag names
      "html", "body", "head", "title", "link", "meta", "style", "div", "p", "span", "a", "img", "image",
      "svg", "path", "g", "br", "hr", "em", "strong", "i", "b", "u", "h1", "h2", "h3", "h4", "h5", "h6",
      "blockquote", "pre", "code", "table", "tr", "td", "th", "tbody", "thead", "tfoot", "col", "colgroup",
      "ul", "ol", "li",
      // Common suffixes (length >= 2)
      "tml", "ml", "ody", "dy", "ead", "ad", "itle", "tle", "le", "ink", "nk", "eta", "ta", "tyle", "yle",
      "iv", "pan", "an", "mage", "age", "ge", "trong", "rong", "ong", "ng", "lockquote", "ockquote", 
      "ckquote", "kquote", "quote", "uote", "ote", "te", "able", "ble", "foot", "oot", "ot", "col", "row"
    ]);

    // 1. Fix leading broken tag (e.g. "body>", "p>", "class=\"test\">")
    const firstOpen = cleaned.indexOf('<');
    const firstClose = cleaned.indexOf('>');
    if (firstClose > -1 && (firstOpen === -1 || firstClose < firstOpen)) {
      if (firstClose < 100) {
        const fragment = cleaned.substring(0, firstClose).trim().toLowerCase();
        
        // Normalize fragment: remove trailing slash for self-closing tags like "br /" or "br/"
        // and leading slash for closing tags like "/div"
        let normFrag = fragment;
        if (normFrag.endsWith('/')) {
          normFrag = normFrag.substring(0, normFrag.length - 1).trim();
        } else if (normFrag.startsWith('/')) {
          normFrag = normFrag.substring(1).trim();
        }

        const isTag = (
          fragment === '' ||
          fragment.indexOf('=') > -1 ||
          knownTags.has(normFrag)
        );
        if (isTag) {
          cleaned = cleaned.substring(firstClose + 1).trim();
        }
      }
    }

    // 2. Fix trailing broken tag (e.g. "</", "<div")
    const lastOpen = cleaned.lastIndexOf('<');
    const lastClose = cleaned.lastIndexOf('>');
    if (lastOpen > -1 && lastOpen > lastClose) {
      const fragment = cleaned.substring(lastOpen);
      // A valid tag fragment must start with '<' followed by a tag name letter, '/', '!', or '?'
      // Or be exactly '<'
      if (fragment === '<' || (fragment.length > 1 && /^[a-zA-Z/!?]/.test(fragment.charAt(1)))) {
        cleaned = cleaned.substring(0, lastOpen).trim();
      }
    }

    return cleaned;
  }
}
