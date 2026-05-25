import zipfile
import xml.etree.ElementTree as ET
import os

epub_path = "/Users/burnfan/Downloads/自由的窄廊：國家與社會如何決定自由的命運-1763215042245.epub"

print("Exists:", os.path.exists(epub_path))
if os.path.exists(epub_path):
    print("Size:", os.path.getsize(epub_path))

try:
    with zipfile.ZipFile(epub_path, 'r') as z:
        print("\n--- Zip Info ---")
        namelist = z.namelist()
        print(f"Total files in zip: {len(namelist)}")
        
        # Read container.xml
        container_xml_path = 'META-INF/container.xml'
        if container_xml_path in namelist:
            container_content = z.read(container_xml_path).decode('utf-8', errors='ignore')
            print("\n--- container.xml ---")
            print(container_content)
            
            # Find rootfile
            root = ET.fromstring(container_content)
            namespaces = {'ns': 'urn:oasis:names:tc:opendocument:xmlns:container'}
            rootfiles = root.findall('.//ns:rootfile', namespaces)
            if not rootfiles:
                # try without namespace
                rootfiles = root.findall('.//rootfile')
            
            if rootfiles:
                opf_path = rootfiles[0].attrib.get('full-path')
                print(f"OPF path found: {opf_path}")
                
                if opf_path in namelist:
                    opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
                    print("\n--- OPF Content (Truncated) ---")
                    print(opf_content[:2000])
                    
                    # Parse OPF XML
                    # Let's inspect manifest and spine
                    opf_root = ET.fromstring(opf_content)
                    ns = {'opf': 'http://www.idpf.org/2007/opf'}
                    manifest_items = opf_root.findall('.//opf:manifest/opf:item', ns)
                    if not manifest_items:
                        manifest_items = opf_root.findall('.//item')
                    
                    print(f"\nManifest items count: {len(manifest_items)}")
                    for item in manifest_items[:15]:
                        print(f"  Item ID: {item.attrib.get('id')}, href: {item.attrib.get('href')}, media-type: {item.attrib.get('media-type')}")
                    
                    spine_items = opf_root.findall('.//opf:spine/opf:itemref', ns)
                    if not spine_items:
                        spine_items = opf_root.findall('.//itemref')
                        
                    print(f"\nSpine items count: {len(spine_items)}")
                    for item in spine_items[:15]:
                        print(f"  itemref idref: {item.attrib.get('idref')}")
                else:
                    print(f"OPF file {opf_path} not found in zip!")
            else:
                print("No rootfile element found in container.xml")
        else:
            print("META-INF/container.xml not found!")
            
except Exception as e:
    print("Error:", e)
