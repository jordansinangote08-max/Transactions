"""Rasterize existing bank SVGs for Scriptable's native Image API.
Requires the environment's Python Playwright and Chromium; no remote resources.
PNG assets are committed, so this is needed only when existing SVG logos change.
"""
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 480, 'height': 320}, device_scale_factor=1)
    page.route('**/*', lambda route: route.abort())
    for source in sorted(root.glob('*.svg')):
        if source.name == 'icon.svg':
            continue
        # Preserve viewBox proportions and scale even 24px source marks up to
        # Retina-friendly sizes. Crop to the SVG box so wide logos stay prominent.
        markup = source.read_text()
        svg = ET.fromstring(markup)
        viewbox = svg.attrib.get('viewBox')
        if viewbox:
            _, _, width, height = map(float, viewbox.replace(',', ' ').split())
        else:
            width = float(svg.attrib['width'].removesuffix('px'))
            height = float(svg.attrib['height'].removesuffix('px'))
            markup = re.sub(r'<svg\b', f'<svg viewBox="0 0 {width} {height}"', markup, count=1)
        scale = min(480 / width, 320 / height)
        width, height = round(width * scale), round(height * scale)
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{width}px;height:{height}px}}</style>' + markup)
        page.locator('svg').screenshot(path=str(root / 'widget-logos' / (source.stem + '.png')), omit_background=True)
    browser.close()
