import zipfile
import re

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

# Find all <a> tags with href in index_split_006.html
a_pattern = re.compile(r'<a\s+[^>]*href=["\']([^"\']*)["\'][^>]*>(.*?)</a>', re.IGNORECASE)
id_pattern = re.compile(r'<[a-z0-9:-]+\s+[^>]*(?:id|name)=["\']([^"\']*)["\']', re.IGNORECASE)

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if 'index_split_006.html' in name:
            content = z.read(name).decode('utf-8', errors='ignore')
            print(f"--- Links in {name} ---")
            matches = a_pattern.findall(content)
            for href, text in matches[:15]:
                print(f"  Link Text: {text} -> href: {href}")
            
            print("\n--- Some IDs/Names in same file ---")
            ids = id_pattern.findall(content)
            for id_val in ids[:15]:
                print(f"  ID/Name: {id_val}")
                
            break
