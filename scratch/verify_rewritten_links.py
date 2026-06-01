import zipfile
import re

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

def get_directory(file_path):
    parts = file_path.split('/')
    parts.pop()
    return "/".join(parts) + "/" if parts else ""

def resolve_path(base_dir, relative_path):
    parts_hash = relative_path.split('#')
    path_part = parts_hash[0]
    hash_part = parts_hash[1] if len(parts_hash) > 1 else None
    
    absolute = base_dir + path_part
    parts = absolute.split('/')
    result = []
    for part in parts:
        if part == '.' or part == '':
            continue
        if part == '..':
            if result:
                result.pop()
        else:
            result.append(part)
    resolved_path = "/".join(result)
    return f"{resolved_path}#{hash_part}" if hash_part is not None else resolved_path

cleanHref = "index_split_006.html"
baseDir = get_directory(cleanHref)

with zipfile.ZipFile(epub_path, 'r') as z:
    for name in z.namelist():
        if 'index_split_006.html' in name:
            content = z.read(name).decode('utf-8', errors='ignore')
            
            # Find all a tags
            # Format: <a ... href="..." ...>text</a> or <a href="...">
            a_tags = re.findall(r'<a\s+[^>]*href=["\']([^"\']*)["\'][^>]*>', content, re.IGNORECASE)
            print("--- Simulated Link Rewriting ---")
            for href in a_tags[:15]:
                if href and not href.startswith('http') and not href.startswith('mailto'):
                    if href.startswith('#'):
                        resolvedLink = cleanHref + href
                    else:
                        resolvedLink = resolve_path(baseDir, href)
                    print(f"Original: {href:<20s} -> Rewritten: {resolvedLink}")
            break
