import zipfile
import xml.etree.ElementTree as ET
import os

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

with zipfile.ZipFile(epub_path, 'r') as z:
    opf_content = z.read('content.opf').decode('utf-8', errors='ignore')
    opf_root = ET.fromstring(opf_content)
    ns = {'opf': 'http://www.idpf.org/2007/opf'}
    
    manifest_items = opf_root.findall('.//opf:manifest/opf:item', ns)
    spine_items = opf_root.findall('.//opf:spine/opf:itemref', ns)
    
    manifest = {}
    for item in manifest_items:
        manifest[item.attrib.get('id')] = item.attrib.get('href')
        
    spine = []
    for item in spine_items:
        spine.append(item.attrib.get('idref'))
        
    print("--- Spine Files ---")
    for i, idref in enumerate(spine):
        print(f"Spine {i}: {idref} -> {manifest.get(idref)}")
        
    # Read toc.ncx or other toc if present
    print("\n--- NCX/TOC Links ---")
    ncx_file = next((href for id_, href in manifest.items() if href.endswith('.ncx')), None)
    if ncx_file and ncx_file in z.namelist():
        ncx_content = z.read(ncx_file).decode('utf-8', errors='ignore')
        ncx_root = ET.fromstring(ncx_content)
        # Find all content src attributes
        # navPoint contains content
        nav_points = ncx_root.findall('.//{http://www.daisy.org/z3986/2005/ncx/}navPoint')
        if not nav_points:
            nav_points = ncx_root.findall('.//navPoint')
        for np in nav_points:
            label = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}text')
            if label is None:
                label = np.find('.//text')
            content = np.find('.//{http://www.daisy.org/z3986/2005/ncx/}content')
            if content is None:
                content = np.find('.//content')
            
            labelText = label.text.strip() if label is not None else "Unknown"
            src = content.attrib.get('src') if content is not None else "None"
            print(f"  TOC Item: {labelText} -> {src}")
