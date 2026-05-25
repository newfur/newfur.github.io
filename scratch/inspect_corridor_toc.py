import zipfile
import xml.etree.ElementTree as ET
import os

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

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
    namelist = z.namelist()
    opf_path = "OEBPS/content.opf"
    opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
    opf_root = ET.fromstring(opf_content)
    
    # 1. Parse manifest
    ns = {'opf': 'http://www.idpf.org/2007/opf'}
    manifest = {}
    manifest_items = opf_root.findall('.//opf:manifest/opf:item', ns)
    if not manifest_items:
        manifest_items = opf_root.findall('.//item')
        
    for item in manifest_items:
        id_ = item.attrib.get('id')
        href = item.attrib.get('href')
        media_type = item.attrib.get('media-type')
        properties = item.attrib.get('properties') or ''
        manifest[id_] = {
            'href': resolve_path('OEBPS/', href),
            'mediaType': media_type,
            'properties': properties
        }
        
    # 2. Check for navItem and ncxItem
    nav_item = None
    for item in manifest.values():
        if 'nav' in item['properties']:
            nav_item = item
            break
            
    ncx_item = None
    for item in manifest.values():
        if item['mediaType'] == 'application/x-dtbncx+xml':
            ncx_item = item
            break
            
    print(f"nav_item: {nav_item}")
    print(f"ncx_item: {ncx_item}")
    
    # 3. Simulate parse TOC
    toc_list = []
    if nav_item:
        print("\nUsing nav_item:")
        nav_href = nav_item['href']
        if nav_href in namelist:
            nav_text = z.read(nav_href).decode('utf-8', errors='ignore')
            print("nav_text preview (first 500 chars):")
            print(nav_text[:500])
            # Let's parse nav_text manually or via simple ET
            try:
                # Find all <a> inside <nav>
                # Let's just print a portion of nav_text or parse via xml
                nav_root = ET.fromstring(nav_text)
                # find all 'a' elements
                links = nav_root.findall('.//{http://www.w3.org/1999/xhtml}a')
                if not links:
                    links = nav_root.findall('.//a')
                print(f"Found {len(links)} links in nav_item")
                for link in links[:10]:
                    href = link.attrib.get('href')
                    title = "".join(link.itertext()).strip()
                    base_dir = get_directory(nav_href)
                    resolved_href = resolve_path(base_dir, href)
                    print(f"  Title: {title}, resolved_href: {resolved_href}")
                    toc_list.append((title, resolved_href))
            except Exception as e:
                print("Error parsing nav_text XML:", e)
        else:
            print(f"nav_href {nav_href} not in namelist!")
            
    if not toc_list and ncx_item:
        print("\nUsing ncx_item:")
        ncx_href = ncx_item['href']
        if ncx_href in namelist:
            ncx_text = z.read(ncx_href).decode('utf-8', errors='ignore')
            print("ncx_text preview (first 500 chars):")
            print(ncx_text[:500])
            try:
                ncx_root = ET.fromstring(ncx_text)
                # ncx namespaces
                # find all navPoint
                points = ncx_root.findall('.//{http://www.daisy.org/z3986/2005/ncx/}navPoint')
                if not points:
                    points = ncx_root.findall('.//navPoint')
                print(f"Found {len(points)} navPoints in ncx_item")
                for point in points[:10]:
                    label = point.find('.//{http://www.daisy.org/z3986/2005/ncx/}navLabel/{http://www.daisy.org/z3986/2005/ncx/}text')
                    if label is None:
                        label = point.find('.//navLabel/text')
                    content = point.find('.//{http://www.daisy.org/z3986/2005/ncx/}content')
                    if content is None:
                        content = point.find('.//content')
                    if label is not None and content is not None:
                        title = label.text.strip() if label.text else ""
                        src = content.attrib.get('src')
                        base_dir = get_directory(ncx_href)
                        resolved_href = resolve_path(base_dir, src)
                        print(f"  Title: {title}, resolved_href: {resolved_href}")
                        toc_list.append((title, resolved_href))
            except Exception as e:
                print("Error parsing ncx_text XML:", e)
        else:
            print(f"ncx_href {ncx_href} not in namelist!")

    # Let's inspect content of a few items in namelist
    print("\nSome zip filenames:")
    for name in namelist[:20]:
        print(f"  {name}")
