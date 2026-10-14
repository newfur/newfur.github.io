// reader/parsers/text-parser.js
// 純文本 (TXT, Markdown) 與 FB2 電子書解析器，提供自動章節拆分、格式轉換與 XML DOM 提取

export class TextParser {
  constructor(fileBlob, format) {
    this.fileBlob = fileBlob;
    this.format = format.toLowerCase();
    this.title = (this.fileBlob && this.fileBlob.name) ? this.fileBlob.name.replace(/\.[a-z0-9]+$/i, '') : 'Unknown Text';
    this.author = 'Unknown Author';
  }

  async parse() {
    if (this.format === 'fb2') {
      return this._parseFB2();
    }
    
    // 讀取文本內容，自動偵測中文編碼 (UTF-8, GB18030, Big5)
    const arrayBuffer = await this.fileBlob.arrayBuffer();
    const text = this._decodeText(arrayBuffer);

    if (this.format === 'md' || this.format === 'markdown') {
      return this._parseMarkdown(text);
    } else {
      return this._parseTXT(text);
    }
  }

  // 解碼二進位，處理中文字元集亂碼問題
  _decodeText(arrayBuffer) {
    const uint8 = new Uint8Array(arrayBuffer);
    
    // 1. 檢測 BOM
    if (uint8[0] === 0xEF && uint8[1] === 0xBB && uint8[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(arrayBuffer);
    }
    if (uint8[0] === 0xFE && uint8[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(arrayBuffer);
    }
    if (uint8[0] === 0xFF && uint8[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(arrayBuffer);
    }

    // 2. 使用 UTF-8 解碼並檢查是否包含無效字元
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      return utf8Decoder.decode(arrayBuffer);
    } catch (e) {
      // 若 UTF-8 解碼失敗，則依據語系環境嘗試簡體中文 (GB18030) 或繁體中文 (Big5)
      const userLang = navigator.language.toLowerCase();
      const fallbackEncoding = (userLang.includes('tw') || userLang.includes('hk') || userLang.includes('mo')) ? 'big5' : 'gb18030';
      try {
        return new TextDecoder(fallbackEncoding).decode(arrayBuffer);
      } catch (err) {
        return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer); // 強制 UTF-8 容錯解碼
      }
    }
  }

  // 1. TXT 解析：按照「第X章/回/卷/節」或「Chapter」進行段落切分
  _parseTXT(text) {
    const chapters = [];
    const lines = text.split(/\r?\n/);
    
    // 正則表達式匹配章節標題
    const chapterRegex = /^\s*(第\s*[一二三四五六七八九十百千零0-9]+\s*[章回卷折篇幕節])|^\s*(Chapter\s*[0-9]+)/i;
    
    let currentChapterTitle = 'Start';
    let currentChapterParas = [];
    let chapterIndex = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (chapterRegex.test(line)) {
        // 保存前一個章節
        if (currentChapterParas.length > 0) {
          chapters.push({
            title: currentChapterTitle,
            href: `chapter-${chapterIndex}`,
            getContent: this._wrapParas(currentChapterParas)
          });
          chapterIndex++;
        }
        currentChapterTitle = line.substring(0, 50); // 截斷過長標題
        currentChapterParas = [];
      } else {
        currentChapterParas.push(line);
      }
    }

    // 保存最後一個章節
    if (currentChapterParas.length > 0 || chapters.length === 0) {
      chapters.push({
        title: currentChapterTitle,
        href: `chapter-${chapterIndex}`,
        getContent: this._wrapParas(currentChapterParas)
      });
    }

    return {
      metadata: {
        title: this.title,
        author: this.author,
        cover: '',
        size: this.fileBlob.size
      },
      chapters
    };
  }

  _wrapParas(paras) {
    const html = paras.map(p => `<p>${this._escapeHTML(p)}</p>`).join('\n');
    return () => html;
  }

  _escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 2. Markdown 解析
  _parseMarkdown(text) {
    const chapters = [];
    const lines = text.split(/\r?\n/);
    
    let currentChapterTitle = 'Introduction';
    let currentChapterLines = [];
    let chapterIndex = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 匹配 # Title 或 ## Section
      const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
      
      if (headerMatch) {
        if (currentChapterLines.length > 0) {
          chapters.push({
            title: currentChapterTitle,
            href: `chapter-${chapterIndex}`,
            getContent: this._compileMarkdown(currentChapterLines)
          });
          chapterIndex++;
        }
        currentChapterTitle = headerMatch[2].trim();
        currentChapterLines = [];
      } else {
        currentChapterLines.push(line);
      }
    }

    if (currentChapterLines.length > 0 || chapters.length === 0) {
      chapters.push({
        title: currentChapterTitle,
        href: `chapter-${chapterIndex}`,
        getContent: this._compileMarkdown(currentChapterLines)
      });
    }

    return {
      metadata: {
        title: this.title,
        author: this.author,
        cover: '',
        size: this.fileBlob.size
      },
      chapters
    };
  }

  // 輕量級 Markdown 轉 HTML 編譯器
  _compileMarkdown(lines) {
    const compiledHtml = [];
    let inList = false;

    const parseInline = (text) => {
      return this._escapeHTML(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        if (inList) {
          compiledHtml.push('</ul>');
          inList = false;
        }
        continue;
      }

      // 列表匹配
      const listMatch = line.match(/^[\-\*]\s+(.+)$/);
      if (listMatch) {
        if (!inList) {
          compiledHtml.push('<ul>');
          inList = true;
        }
        compiledHtml.push(`<li>${parseInline(listMatch[1])}</li>`);
        continue;
      }

      if (inList) {
        compiledHtml.push('</ul>');
        inList = false;
      }

      // 標題匹配
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        compiledHtml.push(`<h${level}>${parseInline(headerMatch[2])}</h${level}>`);
      } else {
        compiledHtml.push(`<p>${parseInline(line)}</p>`);
      }
    }

    if (inList) compiledHtml.push('</ul>');

    const html = compiledHtml.join('\n');
    return () => html;
  }

  // 3. FB2 XML 解析
  _parseFB2() {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = () => {
        try {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(reader.result, 'text/xml');
          
          // 解析元數據
          const titleNode = xmlDoc.querySelector('book-title');
          const title = titleNode ? titleNode.textContent.trim() : this.title;
          
          const authorNode = xmlDoc.querySelector('author');
          let author = 'Unknown Author';
          if (authorNode) {
            const first = authorNode.querySelector('first-name')?.textContent || '';
            const last = authorNode.querySelector('last-name')?.textContent || '';
            author = `${first} ${last}`.trim() || 'Unknown Author';
          }

          // 解析封面（FB2 的封面通常是二進位 Base64 節點）
          let coverUrl = '';
          const coverImageNode = xmlDoc.querySelector('coverpage image');
          if (coverImageNode) {
            const coverId = coverImageNode.getAttribute('l:href') || coverImageNode.getAttribute('href');
            if (coverId) {
              const cleanId = coverId.replace('#', '');
              const binaryNode = xmlDoc.getElementById(cleanId) || xmlDoc.querySelector(`binary[id="${cleanId}"]`);
              if (binaryNode) {
                const contentType = binaryNode.getAttribute('content-type') || 'image/jpeg';
                coverUrl = `data:${contentType};base64,${binaryNode.textContent.trim()}`;
              }
            }
          }

          // 解析章節
          const chapters = [];
          const sections = xmlDoc.querySelectorAll('body > section');
          
          sections.forEach((section, idx) => {
            const titleNode = section.querySelector('title');
            const title = titleNode ? titleNode.textContent.trim() : `Chapter ${idx + 1}`;
            
            // 複製 section 的內容並轉換成標準 HTML
            const clone = section.cloneNode(true);
            const titleEl = clone.querySelector('title');
            if (titleEl) clone.removeChild(titleEl); // 移除標題，只保留段落
            
            // 替換 FB2 專屬標籤為標準標籤
            let htmlContent = clone.innerHTML
              .replace(/<empty-line\s*\/>/g, '<br/>')
              .replace(/<p>/g, '<p>').replace(/<\/p>/g, '</p>')
              .replace(/<strong>/g, '<strong>').replace(/<\/strong>/g, '</strong>')
              .replace(/<emphasis>/g, '<em>').replace(/<\/emphasis>/g, '</em>');
              
            chapters.push({
              title,
              href: `chapter-${idx + 1}`,
              getContent: () => htmlContent
            });
          });

          // 如果沒有找到 section，把整個 body 當作一個章節
          if (chapters.length === 0) {
            const body = xmlDoc.querySelector('body');
            chapters.push({
              title: 'Book Content',
              href: 'chapter-1',
              getContent: () => body ? body.innerHTML : '<p>Empty Book</p>'
            });
          }

          resolve({
            metadata: {
              title,
              author,
              cover: coverUrl,
              size: this.fileBlob.size
            },
            chapters
          });
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this.fileBlob);
    });
  }
}
