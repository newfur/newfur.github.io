import zipfile
import re

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    # Print first 5 html files in the reading order or spine
    # Let's inspect content.opf to find the reading order (spine)
    opf = z.read("content.opf").decode("utf-8", errors="ignore")
    # Extract itemref idrefs from spine
    spine_ids = re.findall(r'<itemref\s+idref="([^"]+)"', opf)
    print("Spine itemref count:", len(spine_ids))
    
    # Extract manifest items to map spine_ids to filenames
    manifest = {}
    for item in re.finditer(r'<item\s+([^>]+)>', opf):
        attrs = item.group(1)
        id_m = re.search(r'id="([^"]+)"', attrs)
        href_m = re.search(r'href="([^"]+)"', attrs)
        if id_m and href_m:
            manifest[id_m.group(1)] = href_m.group(1)
            
    # List first 10 files in spine
    spine_files = []
    for s_id in spine_ids:
        if s_id in manifest:
            spine_files.append(manifest[s_id])
            
    print("First 10 files in reading order:")
    for f in spine_files[:10]:
        print("  ", f)
        
    print("\n--- Inspecting first few spine files ---")
    for f in spine_files[:6]:
        content = z.read(f).decode("utf-8", errors="ignore")
        print(f"\nFile: {f} (size={len(content)})")
        # Print first few characters of body
        body_match = re.search(r'<body[^>]*>(.*?)</body>', content, re.DOTALL | re.IGNORECASE)
        if body_match:
            body_content = body_match.group(1).strip()
            print("  Body start (first 500 chars):", body_content[:500].replace('\n', ' '))
            # Print any image references
            imgs = re.findall(r'<img[^>]+>|<image[^>]+>', body_content, re.I)
            if imgs:
                print("  Images found:")
                for img in imgs:
                    print("    ", img)
            else:
                print("  No images found.")
        else:
            print("  No body found.")
