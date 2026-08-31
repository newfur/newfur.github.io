// reader/parsers/comic-parser.js
// CBZ 漫畫存檔解析器，支持圖片過濾、自然排序與大圖 Object URL 載入

export class ComicParser {
  constructor(fileBlob, resourceOwnership = null, resourceOwner = null) {
    this.fileBlob = fileBlob;
    this.title = (this.fileBlob && this.fileBlob.name) ? this.fileBlob.name.replace(/\.cbz$/i, '') : 'Unknown Comic';
    this.zip = null;
    this.pages = []; // 存儲每個圖片的 href/文件名
    this.resourceOwnership = resourceOwnership;
    this.resourceOwner = resourceOwner;
  }

  async parse() {
    // 1. 加載 JSZip
    this.zip = await JSZip.loadAsync(this.fileBlob);
    
    // 2. 過濾並收集所有圖片檔案
    const imgExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const imageFiles = [];

    this.zip.forEach((relativePath, file) => {
      if (file.dir) return; // 忽略目錄
      
      const lowerPath = relativePath.toLowerCase();
      // 排除 macOS 的垃圾文件與隱藏文件
      if (lowerPath.includes('__macosx/') || lowerPath.split('/').pop().startsWith('.')) return;

      const hasImgExt = imgExtensions.some(ext => lowerPath.endsWith(ext));
      if (hasImgExt) {
        imageFiles.push(relativePath);
      }
    });

    // 3. 使用自然語言排序算法對圖片路徑進行排序 (e.g., page_2.jpg < page_10.jpg)
    imageFiles.sort((a, b) => {
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    this.pages = imageFiles;

    // 4. 將第一頁作為書籍封面
    let coverBlob = null;
    if (this.pages.length > 0) {
      try {
        const coverFile = this.zip.file(this.pages[0]);
        coverBlob = await coverFile.async('blob');
      } catch (e) {
        console.warn('Failed to extract CBZ cover:', e);
      }
    }

    // 將每一頁作為一個虛擬章節，或者直接返回全部圖片頁
    const chapters = this.pages.map((path, index) => {
      return {
        title: `Page ${index + 1}`,
        href: `page-${index + 1}`,
        pageIndex: index,
        filePath: path,
        // 當前頁面的圖片抓取器
        getImageUrl: async (owner = this.resourceOwner) => {
          const file = this.zip.file(path);
          if (!file) throw new Error(`File not found: ${path}`);
          const blob = await file.async('blob');
          const url = URL.createObjectURL(blob);
          this.resourceOwnership?.register(owner, url);
          return url;
        }
      };
    });

    return {
      metadata: {
        title: this.title,
        author: 'Unknown Artist',
        cover: coverBlob,
        size: this.fileBlob.size
      },
      chapters,
      pages: this.pages
    };
  }
}
