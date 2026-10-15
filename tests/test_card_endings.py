"""Browser regression checks. Start the static server on port 8000 first.
Requires Python Playwright and system Chromium; all remote traffic is intercepted.
"""
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import unittest
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8000/'


class CardEndingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1280, 'height': 900})
        self.posts = []
        self.errors = []
        self.cloud_state = None
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        if request.url.startswith(BASE):
            route.continue_()
        elif request.method == 'POST':
            self.posts.append(parse_qs(request.post_data or ''))
            route.fulfill(json={'ok': True}, headers={'Access-Control-Allow-Origin': '*'})
        elif self.cloud_state and parse_qs(urlparse(request.url).query).get('action') == ['state']:
            route.fulfill(json={'ok': True, 'state': self.cloud_state}, headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.abort()

    def open_editor(self, card='EW'):
        self.page.locator(f'[data-edit-card="{card}"]').click()
        self.page.wait_for_function("document.activeElement.id==='customCardName'")

    def add_ending(self, value):
        self.page.get_by_role('button', name='Add another last four digits').click()
        field = self.page.get_by_role('textbox', name='Additional last four digits').last
        expect(field).to_be_focused()
        field.fill(value)

    def save(self):
        self.page.locator('#saveCustomCard').click()

    def test_add_validate_sync_reload_remove_and_layout(self):
        page = self.page
        page.goto(BASE, wait_until='networkidle')
        self.open_editor()
        expect(page.locator('#customCardLast4')).to_have_value('3002')
        self.add_ending('0123')
        self.add_ending('0123')
        self.save()
        expect(page.locator('#cardEditorStatus')).to_contain_text('must be different')
        page.get_by_role('button', name='Remove these last four digits').last.click()
        self.save()
        expect(page.locator('#cardEditorModal')).to_be_hidden()
        expect(page.locator('#card-EW .meta')).to_have_text('•••• 3002 · •••• 0123')
        page.wait_for_function("JSON.parse(localStorage.getItem('smartCardAdvisorBuiltInOverrides_v1')).EW.last4s.length===2")
        page.wait_for_timeout(100)  # Allow queued intercepted sync requests to complete.
        syncs = [json.loads(p['payload'][0]) for p in self.posts if p.get('action') == ['syncCards']]
        self.assertTrue(any(c['id'] == 'EW' and c['last4s'] == ['3002', '0123'] for sync in syncs for c in sync))
        page.reload(wait_until='networkidle')
        self.open_editor()
        expect(page.get_by_role('textbox', name='Additional last four digits')).to_have_value('0123')
        self.add_ending('6023')
        self.save()
        expect(page.locator('#cardEditorStatus')).to_contain_text('already belong to UnionBank')
        page.get_by_role('textbox', name='Additional last four digits').last.fill('4567')
        # One visual inspection batch, at desktop and phone sizes.
        capture_dir = Path(os.environ.get('SCREENSHOT_DIR', '/tmp/transactions-ui'))
        capture_dir.mkdir(parents=True, exist_ok=True)
        for name, width, height in [('desktop', 1280, 900), ('mobile', 390, 844)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.locator('#cardEditorModal .modal-panel').evaluate('(panel)=>panel.scrollTop=0')
            self.assertLessEqual(page.locator('#customCardName').bounding_box()['height'], 56)
            page.screenshot(path=str(capture_dir / f'{name}-endings.png'))
            self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            for button in page.locator('#cardEndings button').all():
                box = button.bounding_box()
                self.assertGreaterEqual(box['width'], 44)
                self.assertGreaterEqual(box['height'], 44)
        page.get_by_role('button', name='Remove these last four digits').last.click()
        page.get_by_role('button', name='Remove these last four digits').click()
        expect(page.locator('#customCardLast4')).to_be_focused()
        self.save()
        expect(page.locator('#cardEditorModal')).to_be_hidden()
        expect(page.locator('#card-EW .meta')).to_have_text('•••• 3002')
        page.reload(wait_until='networkidle')
        self.open_editor()
        expect(page.get_by_role('textbox', name='Additional last four digits')).to_have_count(0)

    def test_cloud_restores_aliases_and_custom_cards_support_them(self):
        self.cloud_state = {'cards': {'customCards': [], 'builtInOverrides': {'EW': {'last4': '3002', 'last4s': ['3002', '0123']}}, 'deletedBuiltIns': []}}
        page = self.page
        page.goto(BASE, wait_until='networkidle')
        expect(page.locator('#card-EW .meta')).to_have_text('•••• 3002 · •••• 0123')
        page.locator('#menuToggle').click()
        page.locator('#addNewCard').click()
        page.wait_for_function("document.activeElement.id==='customCardName'")
        page.locator('#customCardName').fill('Test Card')
        page.locator('#customCardLast4').fill('0001')
        self.add_ending('0042')
        self.save()
        expect(page.locator('#cardEditorModal')).to_be_hidden()
        stored = page.evaluate("JSON.parse(localStorage.getItem('smartCardAdvisorCustomCards_v1'))")
        self.assertEqual(stored[0]['last4s'], ['0001', '0042'])
        expect(page.locator(f"#card-{stored[0]['id']} .meta")).to_have_text('•••• 0001 · •••• 0042')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#openCardsModal').click()
        expect(page.locator('#cardsModalList')).to_contain_text('•••• 0001 · •••• 0042')


if __name__ == '__main__':
    unittest.main()
