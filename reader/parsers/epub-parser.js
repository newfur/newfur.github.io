// reader/parsers/epub-parser.js
// EPUB 電子書解析器，使用 JSZip 解壓並重構章節與資源

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
    this.spine.forEach(idref => {
      const item = this.manifest[idref];
      if (item && item.href && !tocCleanHrefs.has(item.href)) {
        tocChapters.push({
          title: chrome.i18n ? chrome.i18n.getMessage('notes_chapter_title') || 'Notes/Appendix' : 'Notes/Appendix',
          href: item.href,
          hash: '',
          cleanHref: item.href,
          getContent: async () => this.loadChapterContent(item.href)
        });
        tocCleanHrefs.add(item.href);
      }
    });
    
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

  // 解析相對路徑
  _resolvePath(baseDir, relativePath) {
    // 移除 relativePath 中的 ../ 等路徑，計算出最終的絕對 zip 路徑
    const absolute = baseDir + relativePath;
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
    return result.join('/');
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
    let navItem = Object.values(this.manifest).find(item => item.properties.includes('nav'));
    let ncxItem = Object.values(this.manifest).find(item => item.mediaType === 'application/x-dtbncx+xml');

    const tocList = [];

    if (navItem) {
      try {
        let navText = await this.zip.file(navItem.href).async('string');
        // Fix self-closing script tags that break DOMParser in text/html mode
        navText = navText.replace(/<script([^>]*?)\/>/gi, '<script$1></script>');
        const parser = new DOMParser();
        const doc = parser.parseFromString(navText, 'text/html');
        const navLinks = doc.querySelectorAll('nav a');
        
        navLinks.forEach(link => {
          const hrefAttr = link.getAttribute('href');
          const title = link.textContent.trim();
          // navItem.href 的資料夾部分作為 resolved href 的 base
          const baseDir = this._getDirectory(navItem.href);
          const resolvedHref = this._resolvePath(baseDir, hrefAttr);
          
          tocList.push({ title, href: resolvedHref });
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
        const navPoints = xmlDoc.querySelectorAll('navPoint');
        
        navPoints.forEach(point => {
          const labelNode = point.querySelector('navLabel > text');
          const contentNode = point.querySelector('content');
          if (labelNode && contentNode) {
            const title = labelNode.textContent.trim();
            const src = contentNode.getAttribute('src');
            const baseDir = this._getDirectory(ncxItem.href);
            const resolvedHref = this._resolvePath(baseDir, src);
            tocList.push({ title, href: resolvedHref });
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
        getContent: async () => this.loadChapterContent(cleanHref)
      };
    });
  }

  // 讀取某個章節內容並替換資源引用為 Object URL
  async loadChapterContent(cleanHref) {
    const file = this.zip.file(cleanHref);
    if (!file) return `<p style="color:red;">Error: Chapter file not found (${cleanHref})</p>`;
    
    let htmlText = await file.async('string');
    // Fix self-closing script tags that break DOMParser in text/html mode
    htmlText = htmlText.replace(/<script([^>]*?)\/>/gi, '<script$1></script>');
    
    // 解析 DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    const baseDir = this._getDirectory(cleanHref);

    // 1. 替換圖片 src
    const images = doc.querySelectorAll('img, image');
    for (const img of images) {
      const srcAttr = img.getAttribute('src') || img.getAttribute('xlink:href');
      if (srcAttr && !srcAttr.startsWith('data:') && !srcAttr.startsWith('http')) {
        const absoluteImgPath = this._resolvePath(baseDir, srcAttr);
        const imgFile = this.zip.file(absoluteImgPath);
        if (imgFile) {
          try {
            const imgBlob = await imgFile.async('blob');
            const imgUrl = URL.createObjectURL(imgBlob);
            if (img.tagName.toLowerCase() === 'image') {
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

    // 2. 獲取主體內容
    const body = doc.querySelector('body');
    if (!body) return htmlText;

    // 將章節內部跳轉 a 標籤轉換為自定義跳轉事件或屬性
    const links = doc.querySelectorAll('a');
    links.forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('mailto')) {
        // 重寫內部跳轉為 data-epub-href
        const resolvedLink = this._resolvePath(baseDir, href);
        a.setAttribute('data-epub-href', resolvedLink);
        a.removeAttribute('href'); // 移除 href 屬性以防止瀏覽器默認跳轉
        a.style.cursor = 'pointer';
        a.style.textDecoration = 'underline';
      }
    });

    return body.innerHTML;
  }
}
