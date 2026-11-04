#!/usr/bin/python3
"""One request over stdio. Runs in the agent's own Xvfb/AT-SPI session."""
import base64, hashlib, io, json, os, subprocess, sys, time
os.environ.update(DISPLAY=":99", DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/sfa-desktop-bus", NO_AT_BRIDGE="0")
import pyatspi
import gi
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gio, GLib
Gdk.init([])
# Chromium needs the desktop's accessibility status as well as its renderer flag.
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
for setting in ('IsEnabled', 'ScreenReaderEnabled'):
    bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set', GLib.Variant('(ssv)', ('org.a11y.Status', setting, GLib.Variant('b', True))), None, Gio.DBusCallFlags.NONE, 3000, None)

def apps():
    desktop = pyatspi.Registry.getDesktop(0)
    out = []
    for i in range(desktop.childCount):
        app = desktop[i]
        if not app: continue
        try: key = 'pid-' + str(app.get_process_id())
        except (AttributeError, NotImplementedError): key = (app.name or 'app')+'-'+str(i)
        out.append((key, app))
    return out

def app_for(name):
    matches = [(key, app) for key, app in apps() if key == name or name.lower() in (app.name or '').lower()]
    if len(matches) != 1: raise ValueError('Choose one app id from sfa-ui apps (the name is absent or ambiguous).')
    return matches[0]

def nodes(key, app):
    out = []; visited = 0
    def walk(node, indices, ancestors):
        nonlocal visited
        visited += 1
        if visited > 2500 or len(out) >= 150: return
        try:
            state = node.getState()
            visible = state.contains(pyatspi.STATE_SHOWING) and state.contains(pyatspi.STATE_VISIBLE)
            enabled = state.contains(pyatspi.STATE_ENABLED)
            actions = []
            try:
                a = node.queryAction()
                for i in range(a.nActions):
                    n = a.getName(i).lower()
                    if n in ('click', 'press', 'activate', 'jump'): actions.append('invoke')
                    elif n in ('toggle',): actions.append('toggle')
                    elif n in ('expand or contract', 'expand'): actions.append('expand')
            except NotImplementedError: pass
            if state.contains(pyatspi.STATE_EDITABLE): actions.append('set_value')
            if state.contains(pyatspi.STATE_SELECTABLE): actions.append('select')
            role = node.getRoleName()
            name = (node.name or '')[:300]
            if visible and enabled and (actions or name):
                token = hashlib.sha256((name+'|'+role).encode()).hexdigest()[:10]
                ident = key + '.' + '.'.join(map(str, indices)) + ':' + token
                data = {'id': ident, 'name': name, 'role': role, 'context': ' > '.join(ancestors[-3:]), 'actions': sorted(set(actions)), 'password': role == 'password text'}
                if not data['password']:
                    try:
                        text = node.queryText()
                        data['value'] = text.getText(0, min(1000, text.characterCount))
                    except NotImplementedError: pass
                try:
                    r = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    data['bounds'] = [r.x, r.y, r.width, r.height]
                except NotImplementedError: pass
                out.append((data, node))
            # Invisible rows aren't expanded into the output, but their visible descendants may exist.
            for i in range(min(node.childCount, 500)):
                child = node[i]
                if child: walk(child, indices+[i], ancestors+([name or role] if role in ('frame','dialog','menu','document web') else []))
        except (RuntimeError, LookupError): pass
    walk(app, [], [])
    return out

def screenshot(app):
    root = Gdk.get_default_root_window()
    if root is None: raise ValueError('The container desktop is not ready.')
    x, y, w, h = 0, 0, root.get_width(), root.get_height()
    for i in range(app.childCount):
        try:
            r = app[i].queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if r.width > 0 and r.height > 0:
                x, y, w, h = max(0, r.x), max(0, r.y), min(r.width, root.get_width()-max(0,r.x)), min(r.height, root.get_height()-max(0,r.y)); break
        except NotImplementedError: pass
    pix = Gdk.pixbuf_get_from_window(root, x, y, w, h)
    ok, data = pix.save_to_bufferv('png', [], [])
    return {'mime': 'image/png', 'data': base64.b64encode(data).decode()}

def main(p):
    op = p['op']
    if op == 'apps': return {'apps': [{'id': k, 'name': a.name, 'title': a.name} for k, a in apps()]}
    if op == 'open':
        args = [p['app'], *p.get('args', [])]
        if any(n in os.path.basename(args[0]).lower() for n in ('chrom', 'electron', 'code')): args.append('--force-renderer-accessibility=complete')
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return {'text': 'Opened. Run sfa-ui apps to find its app id.'}
    key, app = app_for(p['app'])
    if op == 'screenshot': return {'image': screenshot(app)}
    found = nodes(key, app)
    if op == 'tree': return {'controls': [n for n, _ in found]}
    if op == 'act':
        target = next(((n, a) for n, a in found if n['id'] == p['id']), None)
        if not target: raise ValueError('Control changed. Read the tree again.')
        n, a = target; action = p['action']; value = p.get('value', '')
        if n['name'] != p.get('expectedName') or n['role'] != p.get('expectedRole') or n['password'] != p.get('expectedPassword') or n['context'] != p.get('expectedContext', ''):
            raise ValueError('Control changed after approval. Read the tree again.')
        if action not in n['actions']: raise ValueError('Action is not supported by this control.')
        fallback = False
        if action == 'set_value':
            try: ok = a.queryEditableText().setTextContents(value)
            except NotImplementedError: ok = False
            time.sleep(.05)
            text = a.queryText()
            observed = text.getText(0, text.characterCount)
            if not ok or observed != value:
                if not a.queryComponent().grabFocus(): raise ValueError('Cannot focus this control for the keyboard fallback.')
                time.sleep(.05)
                subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'], check=True)
                subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', value], check=True)
                fallback = True
        elif action == 'select':
            parent = a.parent; parent.querySelection().selectChild(a.getIndexInParent())
        else:
            pattern = a.queryAction(); names = {'invoke': ('click','press','activate','jump'), 'toggle': ('toggle',), 'expand': ('expand','expand or contract')}
            index = next((i for i in range(pattern.nActions) if pattern.getName(i).lower() in names.get(action, ())), None)
            if index is None or not pattern.doAction(index): raise ValueError('AT-SPI refused the action.')
        return {'text': 'Action completed (keyboard fallback).' if fallback else 'Action completed.'}
    if op == 'click':
        # Explicit fallback for canvas apps: window-relative coordinates, never the host display.
        x, y = int(p['x']), int(p['y'])
        r = app[0].queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if not 0 <= x < r.width or not 0 <= y < r.height: raise ValueError('Coordinates outside this window.')
        pyatspi.Registry.generateMouseEvent(r.x+x, r.y+y, 'b1c')
        return {'text': 'Clicked.'}
    raise ValueError('Unknown UI operation.')

try:
    print(json.dumps(main(json.load(sys.stdin))))
except Exception as error:
    print(json.dumps({'error': type(error).__name__+': '+str(error)})); sys.exit(1)
