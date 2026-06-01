import zipfile
import xml.etree.ElementTree as ET

epub_path = "/Users/burnfan/Downloads/马基雅维里时刻：佛罗伦萨政治思想和大西洋-1763205861483.epub"

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

with zipfile.ZipFile(epub_path, 'r') as z:
    # 1. Parse container.xml to get OPF
    container_xml = z.read('META-INF/container.xml').decode('utf-8')
    root = ET.fromstring(container_xml)
    opf_path = root.find('.//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile').attrib.get('full-path')
    opf_dir = get_directory(opf_path)
    
    # 2. Parse OPF
    opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
    opf_root = ET.fromstring(opf_content)
    
    manifest_items = opf_root.findall('.//{http://www.idpf.org/2007/opf}item') or opf_root.findall('.//item')
    manifest = {item.attrib.get('id'): item.attrib.get('href') for item in manifest_items}
    
    # 3. Locate NCX or Navigation document
    ncx_file = next((resolve_path(opf_dir, href) for id_, href in manifest.items() if href.endswith('.ncx')), None)
    
    if ncx_file:
        print(f"Found NCX TOC: {ncx_file}")
        ncx_content = z.read(ncx_file).decode('utf-8', errors='ignore')
        ncx_root = ET.fromstring(ncx_content)
        nav_points = ncx_root.findall('.//{http://www.daisy.org/z3986/2005/ncx/}navPoint') or ncx_root.findall('.//navPoint')
        print(f"Total NavPoints: {len(nav_points)}")
        
        for np in nav_points:
            label = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}navLabel')
            if label is not None:
                text = label.find('.//{http://www.daisy.org/z3986/2005/ncx/}text')
            else:
                text = np.find('.//text')
            content = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}content') or np.find('.//content')
            if text is not None and content is not None:
                title = text.text.strip() if text.text else ""
                src = content.attrib.get('src')
                resolved = resolve_path(get_directory(ncx_file), src)
                print(f"Title: {title:40s} -> src: {src:25s} -> resolved: {resolved}")
    else:
        print("No NCX file found.")
