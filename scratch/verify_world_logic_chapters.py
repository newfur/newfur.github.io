import zipfile
import xml.etree.ElementTree as ET
import os

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

def get_directory(file_path):
    parts = file_path.split('/')
    parts.pop()
    return "/".join(parts) + "/" if parts else ""

def resolve_path(base_dir, relative_path):
    absolute = base_dir + relative_path
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
    return "/".join(result)

with zipfile.ZipFile(epub_path, 'r') as z:
    # 1. Parse container.xml to get OPF
    container_xml = z.read('META-INF/container.xml').decode('utf-8')
    root = ET.fromstring(container_xml)
    opf_path = root.find('.//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile').attrib.get('full-path')
    opf_dir = get_directory(opf_path)
    
    # 2. Parse OPF
    opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
    opf_root = ET.fromstring(opf_content)
    ns = {'opf': 'http://www.idpf.org/2007/opf'}
    
    manifest_items = opf_root.findall('.//opf:manifest/opf:item', ns)
    spine_items = opf_root.findall('.//opf:spine/opf:itemref', ns)
    
    manifest = {}
    for item in manifest_items:
        id_ = item.attrib.get('id')
        href = item.attrib.get('href')
        manifest[id_] = resolve_path(opf_dir, href)
        
    spine = [item.attrib.get('idref') for item in spine_items]
    spine_hrefs = [manifest[id_] for id_ in spine if id_ in manifest]
    
    # 3. Simulate _parseTOC (representing standard NCX parse)
    toc_chapters = []
    ncx_file = next((href for id_, href in manifest.items() if href.endswith('.ncx')), None)
    if ncx_file:
        ncx_content = z.read(ncx_file).decode('utf-8', errors='ignore')
        ncx_root = ET.fromstring(ncx_content)
        nav_points = ncx_root.findall('.//{http://www.daisy.org/z3986/2005/ncx/}navPoint')
        if not nav_points:
            nav_points = ncx_root.findall('.//navPoint')
        for np in nav_points:
            label = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}text') or np.find('.//text')
            content = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}content') or np.find('.//content')
            if label is not None and content is not None:
                title = label.text.strip()
                src = content.attrib.get('src')
                resolved_href = resolve_path(get_directory(ncx_file), src)
                clean_href = resolved_href.split('#')[0]
                toc_chapters.append({
                    'title': title,
                    'href': resolved_href,
                    'cleanHref': clean_href,
                    'hiddenFromTOC': False
                })
                
    # 4. Simulate adding missing spine items (Step 6)
    toc_clean_hrefs = set(ch['cleanHref'] for ch in toc_chapters)
    for idref in spine:
        if idref in manifest:
            href = manifest[idref]
            if href not in toc_clean_hrefs:
                toc_chapters.append({
                    'title': 'Notes/Appendix',
                    'href': href,
                    'cleanHref': href,
                    'hiddenFromTOC': True
                })
                toc_clean_hrefs.add(href)
                
    # 5. Simulate sorting (Step 7)
    toc_chapters.sort(key=lambda ch: spine_hrefs.index(ch['cleanHref']))
    
    # 6. Simulate title inheritance (Step 8)
    for i in range(len(toc_chapters)):
        if toc_chapters[i]['hiddenFromTOC']:
            if i > 0:
                toc_chapters[i]['title'] = toc_chapters[i-1]['title']
            else:
                toc_chapters[i]['title'] = "Start"
                
    # 7. Print final chapter list
    print("--- Simulated Parser Chapter Sequence ---")
    for i, ch in enumerate(toc_chapters):
        print(f"Index {i:2d}: href={ch['cleanHref']:<25s} hidden={ch['hiddenFromTOC']!s:<6} title={ch['title']}")
