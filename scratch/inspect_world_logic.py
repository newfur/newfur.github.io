import zipfile
import xml.etree.ElementTree as ET
import os

epub_path = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub"

print("Exists:", os.path.exists(epub_path))
if os.path.exists(epub_path):
    print("Size:", os.path.getsize(epub_path))

try:
    with zipfile.ZipFile(epub_path, 'r') as z:
        namelist = z.namelist()
        print(f"Total files in zip: {len(namelist)}")
        
        # Read container.xml
        container_xml_path = 'META-INF/container.xml'
        if container_xml_path in namelist:
            container_content = z.read(container_xml_path).decode('utf-8', errors='ignore')
            
            # Find rootfile
            root = ET.fromstring(container_content)
            namespaces = {'ns': 'urn:oasis:names:tc:opendocument:xmlns:container'}
            rootfiles = root.findall('.//ns:rootfile', namespaces)
            if not rootfiles:
                rootfiles = root.findall('.//rootfile')
            
            if rootfiles:
                opf_path = rootfiles[0].attrib.get('full-path')
                print(f"OPF path found: {opf_path}")
                
                if opf_path in namelist:
                    opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
                    opf_root = ET.fromstring(opf_content)
                    ns = {'opf': 'http://www.idpf.org/2007/opf'}
                    manifest_items = opf_root.findall('.//opf:manifest/opf:item', ns)
                    if not manifest_items:
                        manifest_items = opf_root.findall('.//item')
                    
                    print(f"\nManifest items count: {len(manifest_items)}")
                    
                    # Print first 20 items and all items that have "image" in media-type
                    print("\n--- Image items in manifest ---")
                    for item in manifest_items:
                        media_type = item.attrib.get('media-type', '')
                        if 'image' in media_type:
                            print(f"  Item ID: {item.attrib.get('id')}, href: {item.attrib.get('href')}, media-type: {media_type}")
                    
                    spine_items = opf_root.findall('.//opf:spine/opf:itemref', ns)
                    if not spine_items:
                        spine_items = opf_root.findall('.//itemref')
                        
                    print(f"\nSpine items count: {len(spine_items)}")
                    
                    # Let's inspect the first couple of chapter files in the spine
                    base_dir = os.path.dirname(opf_path)
                    print(f"Base dir of OPF: {base_dir}")
                    
                    for i, spine_item in enumerate(spine_items[:5]):
                        idref = spine_item.attrib.get('idref')
                        # Find in manifest
                        item = next((x for x in manifest_items if x.attrib.get('id') == idref), None)
                        if item is not None:
                            href = item.attrib.get('href')
                            full_href = os.path.join(base_dir, href) if base_dir else href
                            # normalize path
                            full_href = os.path.normpath(full_href)
                            print(f"\nSpine item {i}: idref={idref}, zip_path={full_href}")
                            if full_href in namelist:
                                content = z.read(full_href).decode('utf-8', errors='ignore')
                                print(f"--- Content of {full_href} (first 1500 chars) ---")
                                print(content[:1500])
                            else:
                                print(f"File {full_href} not found in zip!")
                else:
                    print(f"OPF file {opf_path} not found in zip!")
            else:
                print("No rootfile element found in container.xml")
        else:
            print("META-INF/container.xml not found!")
            
except Exception as e:
    print("Error:", e)
