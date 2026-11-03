"""
自动验收检查（可选工具，不是网站运行所必需）。
需要：Python 3 + playwright（pip install playwright && playwright install chromium）
运行：python3 tests/acceptance_test.py
可用环境变量 CHROME 指定浏览器路径。
使用 Playwright 的虚拟时钟快进时间，所以 20 秒来电、5 秒通知等场景几秒内即可跑完。
"""
import asyncio, os, pathlib, sys
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'index.html').as_uri()
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))

async def snap(pg):
    return await pg.evaluate('window.dashDebug.snapshot()')

async def boot(pg):
    await pg.click('#demoReset')
    await pg.keyboard.press('x')
    await pg.clock.run_for(3200)

async def goto(pg, page):
    """从首页经 Menu 进入某页：按 Page 若干次后按 OK 立即进入。"""
    order = ['home', 'map', 'media', 'vehicle', 'settings']
    await pg.keyboard.press('h')
    n = order.index(page)
    if n == 0:
        return
    for _ in range(n):
        await pg.keyboard.press('p')
    await pg.keyboard.press('Enter')

async def main():
    async with async_playwright() as p:
        kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
        b = await p.chromium.launch(**kw)
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.clock.install()
        await pg.goto(URL)

        # 初始状态
        s = await snap(pg)
        check('初始：OFF，弹窗为空', s['powerState'] == 'OFF' and s['activeOverlay'] is None)

        await boot(pg)
        s = await snap(pg)
        check('开机 3 秒后进入 READY 与首页', s['powerState'] == 'READY' and s['currentPage'] == 'home')

        # 1. 连按五次 Page：Menu 依次选中下一页，循环回 HOME；3 秒后留在首页
        seq = []
        for _ in range(5):
            await pg.keyboard.press('p')
            st = await snap(pg)
            seq.append(st['menuSelection'])
        under = st['currentPage']
        await pg.clock.run_for(3100)
        s = await snap(pg)
        check('1. 连按五次 Page，Menu 选回 HOME，3 秒后留在首页',
              seq == ['map', 'media', 'vehicle', 'settings', 'home'] and under == 'home'
              and not s['menuOpen'] and s['currentPage'] == 'home', ' → '.join(seq))

        # 1b. 首页按 Page 出现 MENU NAVIGATION，底下仍是首页；3 秒不动自动进入导航页
        await pg.keyboard.press('p')
        s1 = await snap(pg)
        label = await pg.inner_text('.menu-label')
        await pg.clock.run_for(2800)
        s2 = await snap(pg)
        await pg.clock.run_for(400)
        s3 = await snap(pg)
        check('1b. 首页按 Page 出现 MENU NAVIGATION，3 秒后自动进入导航页',
              s1['menuOpen'] and label == 'NAVIGATION' and s1['currentPage'] == 'home'
              and s2['menuOpen'] and s3['currentPage'] == 'map' and not s3['menuOpen'])

        # 1c. 每次 Page 都重新计时 3 秒
        await pg.keyboard.press('h')
        await pg.keyboard.press('p'); await pg.clock.run_for(2500)
        await pg.keyboard.press('p'); await pg.clock.run_for(2500)
        s = await snap(pg)
        await pg.clock.run_for(700)
        s2 = await snap(pg)
        check('1c. Menu 中每按一次 Page 重新计时 3 秒',
              s['menuOpen'] and s['menuSelection'] == 'media' and s2['currentPage'] == 'media')

        # 1d. 右键下一项、左键上一项，两端循环；OK 立即进入
        await pg.keyboard.press('h')
        await pg.keyboard.press('p')
        await pg.keyboard.press('ArrowLeft')
        a1 = (await snap(pg))['menuSelection']
        await pg.keyboard.press('ArrowLeft')
        a2 = (await snap(pg))['menuSelection']
        await pg.keyboard.press('ArrowRight')
        a3 = (await snap(pg))['menuSelection']
        await pg.keyboard.press('Enter')
        s = await snap(pg)
        check('1d. Menu 左右键切换并循环，OK 立即进入',
              a1 == 'home' and a2 == 'settings' and a3 == 'home' and not s['menuOpen'] and s['currentPage'] == 'home',
              f'{a1} → {a2} → {a3}')

        # 1e. 从其他页按 Page，Menu 选中“当前页的下一页”
        await goto(pg, 'vehicle')
        await pg.keyboard.press('p')
        s = await snap(pg)
        await pg.keyboard.press('Enter')
        check('1e. 车辆页按 Page，Menu 选中 SETTINGS', s['menuSelection'] == 'settings'
              and (await snap(pg))['currentPage'] == 'settings')

        # 1f. Menu 打开时 Trip / 上 / 下 被忽略且不重新计时；Home 关闭 Menu 回首页
        await pg.keyboard.press('h')
        await pg.keyboard.press('p'); await pg.clock.run_for(2000)
        for k in ['t', 'ArrowUp', 'ArrowDown']:
            await pg.keyboard.press(k)
        mid = await snap(pg)
        await pg.clock.run_for(1100)
        s = await snap(pg)
        await pg.keyboard.press('h')
        await pg.keyboard.press('p')
        await pg.keyboard.press('h')
        s2 = await snap(pg)
        check('1f. Menu 中 Trip/上/下 被忽略且不重新计时；Home 关闭 Menu 回首页',
              mid['menuSelection'] == 'map' and mid['tripIndex'] == 0 and s['currentPage'] == 'map'
              and not s2['menuOpen'] and s2['currentPage'] == 'home')

        # 2. 任意普通页面按 Home 返回首页
        ok2 = True
        for pgname in ['map', 'media', 'vehicle', 'settings']:
            await goto(pg, pgname)
            ok2 &= (await snap(pg))['currentPage'] == pgname
            await pg.keyboard.press('h')
            ok2 &= (await snap(pg))['currentPage'] == 'home'
        await pg.keyboard.press('h')
        ok2 &= (await snap(pg))['currentPage'] == 'home'
        check('2. 任意普通页面按 Home 返回首页（首页按 Home 保持）', ok2)

        # 3. 首页 Trip 五项循环；下键同 Trip，上键反向
        items = []
        for _ in range(5):
            await pg.keyboard.press('t')
            items.append((await snap(pg))['tripItem'])
        await pg.keyboard.press('ArrowDown')
        d1 = (await snap(pg))['tripItem']
        await pg.keyboard.press('ArrowUp'); await pg.keyboard.press('ArrowUp')
        u2 = (await snap(pg))['tripItem']
        check('3. 首页 Trip / 下键五项循环，上键反向循环',
              items == ['ambient', 'range', 'tripA', 'tripB', 'odometer'] and d1 == 'ambient' and u2 == 'tripB',
              ' → '.join(items) + f' | 下:{d1} 上上:{u2}')

        # 4. 非首页按 Trip 不变
        await pg.keyboard.press('h')
        await pg.keyboard.press('t')  # 首页切到下一项
        await goto(pg, 'map')
        before = await snap(pg)
        html_before = await pg.inner_html('#page')
        await pg.keyboard.press('t')
        after = await snap(pg)
        check('4. 非首页按 Trip，页面和数据不变',
              before['currentPage'] == after['currentPage'] == 'map' and before['tripIndex'] == after['tripIndex']
              and html_before == await pg.inner_html('#page'))

        # 4b. 导航、媒体显示 No Device Connected；车辆显示 Diagnostics，OK 无操作
        nav_txt = await pg.inner_text('#page')
        await goto(pg, 'media')
        media_txt = await pg.inner_text('#page')
        await goto(pg, 'vehicle')
        veh_txt = await pg.inner_text('#page')
        await pg.keyboard.press('Enter')
        check('4b. 导航/媒体显示 No Device Connected；车辆页 OK 不进入诊断',
              'No Device Connected' in nav_txt and 'No Device Connected' in media_txt
              and 'Diagnostics' in veh_txt and (await snap(pg))['currentPage'] == 'vehicle')

        # 4c. 设置列表上下移动高亮，不循环，翻到第二屏
        await goto(pg, 'settings')
        await pg.keyboard.press('ArrowUp')
        top = (await snap(pg))['settingsIndex']
        for _ in range(4):
            await pg.keyboard.press('ArrowDown')
        s = await snap(pg)
        sel_txt = await pg.inner_text('.settings-list li.sel')
        for _ in range(3):
            await pg.keyboard.press('ArrowDown')
        bottom = (await snap(pg))['settingsIndex']
        await pg.keyboard.press('Enter')
        check('4c. 设置列表上下移动高亮（顶/底不循环），OK 不进入子页面',
              top == 0 and s['settingsIndex'] == 4 and sel_txt == 'Phone Notifications' and bottom == 5
              and (await snap(pg))['currentPage'] == 'settings')

        # 5. 设置页开始移动，列表被隐藏并显示提示；停车后恢复
        await goto(pg, 'settings')
        vis0 = await pg.is_visible('#restrictLayer')
        await pg.click('[data-speed="30"]')
        vis1 = await pg.is_visible('#restrictLayer')
        txt = await pg.inner_text('#restrictLayer')
        await pg.keyboard.press('ArrowDown')
        moved = (await snap(pg))['settingsIndex']
        await pg.click('[data-speed="0"]')
        vis2 = await pg.is_visible('#restrictLayer')
        check('5. 设置页移动时显示 Settings are hidden while riding，停车后恢复',
              (not vis0) and vis1 and 'Settings are hidden while riding' in txt and moved == 0 and not vis2)
        # 5b. 受限时仍可通过 Menu / Home 离开；骑行中经 Menu 选 SETTINGS 照常进入并显示提示
        await pg.click('[data-speed="30"]')
        await pg.keyboard.press('p')
        menu_over = await pg.is_visible('#menuLayer')
        await pg.keyboard.press('Enter')
        left_ok = (await snap(pg))['currentPage'] == 'home'
        for _ in range(4):
            await pg.keyboard.press('p')
        await pg.clock.run_for(3100)
        s = await snap(pg)
        hidden = await pg.is_visible('#restrictLayer')
        await pg.click('[data-speed="0"]')
        check('5b. 受限时可经 Menu 离开设置；骑行中选 SETTINGS 照常进入并显示提示',
              menu_over and left_ok and s['currentPage'] == 'settings' and hidden
              and not await pg.is_visible('#restrictLayer'))

        # 5c. Menu 打开时来通知：通知优先，Menu 取消，留在原页面
        await pg.keyboard.press('h')
        await pg.keyboard.press('p'); await pg.keyboard.press('p')
        await pg.click('#demoSms')
        s = await snap(pg)
        await pg.clock.run_for(4000)
        s2 = await snap(pg)
        await pg.keyboard.press('Enter')
        s3 = await snap(pg)
        check('5c. Menu 打开时来通知：通知优先，Menu 取消，留在原页面',
              s['activeOverlay']['kind'] == 'notice' and not s['menuOpen'] and s['currentPage'] == 'home'
              and s2['currentPage'] == 'home' and s3['activeOverlay'] is None and s3['currentPage'] == 'home')

        # 6. 来电按确认只接听，不改变底层页面
        await goto(pg, 'map')
        await pg.click('#demoCall')
        s1 = await snap(pg)
        await pg.keyboard.press('Enter')
        s2 = await snap(pg)
        check('6. 来电按确认只接听，底层页面不变',
              s1['activeOverlay']['kind'] == 'call' and s2['callState'] == 'CONNECTED'
              and s2['activeOverlay'] is None and s2['currentPage'] == 'map' and s2['tripIndex'] == s1['tripIndex'])
        await pg.click('#demoCallEnd')

        # 7. 来电按下只拒接；其他方向与 Page 被忽略
        await pg.click('#demoCall')
        for k in ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'p', 'h', 't']:
            await pg.keyboard.press(k)
        mid = await snap(pg)
        await pg.keyboard.press('ArrowDown')
        s = await snap(pg)
        check('7. 来电按下只拒接（其他按键被忽略）',
              mid['activeOverlay'] and mid['activeOverlay']['kind'] == 'call' and mid['currentPage'] == 'map'
              and s['callState'] == 'IDLE' and s['activeOverlay'] is None and s['currentPage'] == 'map')

        # 8. 普通通知显示时触发警告，警告立即优先
        await pg.click('#demoSms')
        n1 = (await snap(pg))['activeOverlay']
        await pg.clock.run_for(2000)
        await pg.click('#demoWarn')
        s = await snap(pg)
        check('8. 普通通知显示时触发警告，警告立即优先',
              n1['kind'] == 'notice' and s['activeOverlay']['kind'] == 'warning'
              and s['pendingNotifications'][0] == n1['id'])

        # 旧通知计时器不能误关新警告
        await pg.clock.run_for(6000)
        s = await snap(pg)
        check('8b. 旧通知的 5 秒计时不会误关警告', s['activeOverlay'] and s['activeOverlay']['kind'] == 'warning')

        # 9. 警告关闭（确认）后，等待通知恢复并重新计时 5 秒
        await pg.keyboard.press('Enter')
        s = await snap(pg)
        restored = s['activeOverlay'] and s['activeOverlay']['id'] == n1['id']
        await pg.clock.run_for(4500)
        still = (await snap(pg))['activeOverlay']
        await pg.clock.run_for(800)
        gone = (await snap(pg))['activeOverlay']
        marker = await pg.inner_text('#protected')
        check('9. 警告确认后等待通知恢复，并重新计时 5 秒',
              restored and still and still['id'] == n1['id'] and gone is None)
        check('9b. 确认警告后保留标记、故障条件仍在、不再重复弹出',
              '胎压' in marker and s['warningConditions'] and (await snap(pg))['activeOverlay'] is None)
        await pg.click('#demoWarnClear')
        await pg.click('#demoWarn')
        check('9c. 警告解除后再次发生，重新提示', (await snap(pg))['activeOverlay']['kind'] == 'warning')
        await pg.click('#demoWarnClear')
        check('9d. 警告条件解除时弹窗自动关闭', (await snap(pg))['activeOverlay'] is None)

        # 10. 关机后等待超过原通知期限，不出现旧弹窗
        await pg.click('#demoSms'); await pg.click('#demoMsg'); await pg.click('#demoCall'); await pg.click('#demoWarn')
        await pg.keyboard.press('x')
        s_off = await snap(pg)
        await pg.clock.run_for(25000)
        s_late = await snap(pg)
        await pg.keyboard.press('x'); await pg.clock.run_for(3200)
        s_on = await snap(pg)
        check('10. 关机后等待超过原期限，没有旧弹窗；再开机回首页',
              s_off['powerState'] == 'OFF' and s_late['activeOverlay'] is None and s_on['activeOverlay'] is None
              and s_on['pendingNotifications'] == [] and s_on['callState'] == 'IDLE' and s_on['currentPage'] == 'home'
              and not await pg.is_visible('#overlay'))

        # 10b. Menu 打开时关机：Menu 与计时一起清除，再开机回首页
        await pg.keyboard.press('p'); await pg.keyboard.press('p')
        await pg.keyboard.press('x')
        await pg.clock.run_for(5000)
        await pg.keyboard.press('x'); await pg.clock.run_for(3200)
        s = await snap(pg)
        check('10b. Menu 打开时关机，再开机不恢复 Menu、回到首页',
              not s['menuOpen'] and s['menuSelection'] is None and s['currentPage'] == 'home'
              and not await pg.is_visible('#menuLayer'))

        # ---- 其他规则 ----
        await pg.click('#demoCall')
        await pg.clock.run_for(20500)
        s = await snap(pg)
        check('来电 20 秒无人接听自动结束', s['callState'] == 'IDLE' and s['activeOverlay'] is None)

        await pg.click('#demoCall')
        await pg.clock.run_for(5000)
        await pg.click('#demoWarn')
        await pg.clock.run_for(16000)
        await pg.keyboard.press('Enter')
        s = await snap(pg)
        check('被警告挡住的来电过期后不再显示（期限不暂停）', s['callState'] == 'IDLE' and s['activeOverlay'] is None)
        await pg.click('#demoWarnClear')

        await pg.click('#demoCall')
        await pg.click('#demoWarn')
        await pg.keyboard.press('Enter')
        s = await snap(pg)
        check('来电被警告挡住、仍有效时恢复显示', s['activeOverlay'] and s['activeOverlay']['kind'] == 'call')
        await pg.click('#demoCallCancel')
        check('对方取消来电，弹窗关闭', (await snap(pg))['activeOverlay'] is None)
        await pg.click('#demoWarnClear')

        await pg.click('#demoSms')
        first = (await snap(pg))['activeOverlay']['id']
        for _ in range(7):
            await pg.click('#demoMsg')
        s = await snap(pg)
        await pg.click('#demoDup')
        s2 = await snap(pg)
        check('队列最多 5 条、同编号不重复入队',
              len(s['pendingNotifications']) == 5 and s2['pendingNotifications'] == s['pendingNotifications'])
        await pg.keyboard.press('Enter')
        nxt = (await snap(pg))['activeOverlay']['id']
        check('同优先级按先来后到显示', nxt == s['pendingNotifications'][0] and nxt != first)

        # 键盘：长按不重复触发
        await boot(pg)
        await pg.keyboard.down('p')
        for _ in range(10):
            await pg.keyboard.down('p')  # 产生 repeat 事件
        await pg.keyboard.up('p')
        s = await snap(pg)
        check('键盘长按 Page 只打开一次 Menu、只选中一项', s['menuOpen'] and s['menuSelection'] == 'map')

        # 键盘：输入框内打字不触发快捷键
        await pg.keyboard.press('h')
        await pg.click('#speedInput')
        await pg.keyboard.press('Control+a')
        await pg.keyboard.type('pht')
        s = await snap(pg)
        await pg.keyboard.press('Enter')
        s2 = await snap(pg)
        check('在演示输入框打字不触发仪表快捷键', s['currentPage'] == 'home' and s['tripIndex'] == 0 and s2['currentPage'] == 'home')
        check('非法车速被拒绝并保留上次有效值', s2['speed'] == 0 and 'error' in (await pg.get_attribute('#speedMsg', 'class')))
        await pg.fill('#speedInput', '-5'); await pg.keyboard.press('Enter')
        check('负数车速被拒绝', (await snap(pg))['speed'] == 0)
        await pg.fill('#speedInput', '45'); await pg.keyboard.press('Enter')
        check('合法车速被接受', (await snap(pg))['speed'] == 45)
        await pg.click('[data-speed="0"]')

        # 键盘：焦点在按钮上按 Enter 只执行一个动作
        await pg.focus('#demoSms')
        await pg.keyboard.press('Enter')
        s = await snap(pg)
        check('焦点在演示按钮上按 Enter 只触发该按钮，不同时关闭通知',
              s['activeOverlay'] and s['activeOverlay']['kind'] == 'notice')
        await pg.evaluate('document.activeElement.blur()')
        await pg.keyboard.press('Enter')
        check('Enter 键关闭通知', (await snap(pg))['activeOverlay'] is None)

        # 鼠标点击实体按钮
        await pg.click('.hw[data-btn="page"]')
        await pg.click('.hw[data-btn="ok"]')
        check('鼠标点击实体按钮生效', (await snap(pg))['currentPage'] == 'map')

        # 点击仪表盘文字不跳转
        await pg.click('#dial', force=True)
        await pg.click('.page-name', force=True)
        check('点击仪表盘内部不改变状态', (await snap(pg))['currentPage'] == 'map')

        # BOOTING 时忽略输入，且不在之后补执行
        await pg.click('#demoReset')
        await pg.keyboard.press('x')
        await pg.keyboard.press('p'); await pg.keyboard.press('t')
        await pg.clock.run_for(3200)
        s = await snap(pg)
        check('BOOTING 期间的输入被忽略且不补执行', s['currentPage'] == 'home' and s['tripIndex'] == 0 and not s['menuOpen'])
        await pg.keyboard.press('x'); await pg.keyboard.press('x'); await pg.clock.run_for(500); await pg.keyboard.press('x')
        await pg.clock.run_for(4000)
        check('BOOTING 时可以关机', (await snap(pg))['powerState'] == 'OFF')

        # 数据缺失显示 —
        await boot(pg)
        await pg.check('#demoMissing')
        await pg.keyboard.press('t')
        trip_txt = await pg.inner_text('.trip-box')
        await goto(pg, 'vehicle')
        veh = await pg.inner_text('#page')
        check('数据缺失显示“—”而不是 0', '—' in trip_txt and '—' in veh, trip_txt.replace('\n', ' '))
        await pg.uncheck('#demoMissing')

        # 重置：清除旧计时
        await pg.click('#demoSms'); await pg.click('#demoCall'); await pg.click('#demoWarn')
        await pg.click('#demoReset')
        s = await snap(pg)
        await pg.keyboard.press('x'); await pg.clock.run_for(3200)
        await pg.clock.run_for(30000)
        s2 = await snap(pg)
        check('重置演示恢复初始状态并清除计时',
              s['powerState'] == 'OFF' and s['pendingNotifications'] == [] and s['callState'] == 'IDLE'
              and s2['activeOverlay'] is None and s2['warningConditions'] == [])

        # 调试开关
        hidden0 = not await pg.is_visible('#debug')
        await pg.check('#debugToggle')
        dbg = await pg.inner_text('#debug')
        check('调试信息默认关闭，开启后显示状态', hidden0 and 'pendingNotifications' in dbg and 'powerState' in dbg)

        # 保护区不被弹窗覆盖
        await pg.click('#demoWarn')
        ov = await pg.locator('#overlay').bounding_box()
        pr = await pg.locator('#protected').bounding_box()
        check('弹窗不覆盖底部保护区', ov['y'] + ov['height'] <= pr['y'] + 1, f"overlay bottom {ov['y']+ov['height']:.0f}, protected top {pr['y']:.0f}")

        # 小屏幕布局
        await pg.set_viewport_size({'width': 390, 'height': 844})
        sw = await pg.evaluate('document.documentElement.scrollWidth')
        dash = await pg.locator('.zone-dash').bounding_box(); btns = await pg.locator('.zone-buttons').bounding_box(); demo = await pg.locator('.zone-demo').bounding_box()
        check('小屏幕：无横向滚动，三个区域上下排列',
              sw <= 390 and dash['y'] < btns['y'] < demo['y'], f'scrollWidth={sw}')

        check('页面无 JavaScript 错误', not errors, '; '.join(errors))
        await b.close()

    w = max(len(n) for n, _, _ in results)
    for n, ok, d in results:
        print(f"{'通过' if ok else '失败'}  {n}{('  [' + d + ']') if d else ''}")
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n合计 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
    sys.exit(1 if failed else 0)

asyncio.run(main())
