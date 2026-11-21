/**
 * VS Code bundle, Client half.
 *
 * The panel is a thin port over one long-lived iframe. React unmounts the port
 * whenever another main panel is selected, so the iframe itself lives in a
 * fixed container attached to `document.body`: hiding it with `display: none`
 * keeps the workbench, its editors, undo history and terminals alive, and a
 * later visit reveals the same session instead of booting a new one.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-vscode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The one long-lived browser surface behind the panel. */
    function createSurface() {
      let element
      let frame
      let visible = false
      let rect
      let scheme = 'dark'
      let configPromise
      let disposed = false

      const loadConfig = () => {
        if (configPromise === undefined) {
          configPromise = fetch('/dsh-vscode/config', { cache: 'no-store' })
            .then(response => (response.ok ? response.json() : { folder: '' }))
            .catch(() => ({ folder: '' }))
        }
        return configPromise
      }

      const pushScheme = () => {
        fetch('/dsh-vscode/theme', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scheme }),
          keepalive: true,
        }).catch(() => {})
      }

      const sync = () => {
        if (element === undefined) return
        if (!visible || rect === undefined) {
          element.style.display = 'none'
          return
        }
        element.style.display = 'block'
        element.style.left = `${Math.round(rect.left)}px`
        element.style.top = `${Math.round(rect.top)}px`
        element.style.width = `${Math.round(rect.width)}px`
        element.style.height = `${Math.round(rect.height)}px`
      }

      const ensure = () => {
        if (element !== undefined || disposed) return
        element = document.createElement('div')
        element.id = 'dsh-vscode-surface'
        element.dataset.dshPlugin = '@local/dsh-vscode'
        Object.assign(element.style, {
          position: 'fixed',
          display: 'none',
          zIndex: '10',
          margin: '0',
          padding: '0',
          border: '0',
          overflow: 'hidden',
          background: '#1e1e1e',
          borderRadius: '0',
          contain: 'layout paint size',
        })
        frame = document.createElement('iframe')
        frame.id = 'dsh-vscode-frame'
        frame.title = 'VS Code'
        frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen')
        frame.setAttribute('allowfullscreen', '')
        Object.assign(frame.style, {
          width: '100%',
          height: '100%',
          display: 'block',
          border: '0',
          margin: '0',
          background: '#1e1e1e',
        })
        frame.addEventListener('load', pushScheme)
        void loadConfig().then((config) => {
          if (disposed || frame === undefined) return
          // code-server resolves `?folder=` as a URI path: a Windows path with
          // backslashes makes the explorer fail to resolve a filesystem
          // provider ("Unable to resolve filesystem provider ..."). Forward
          // slashes work on every platform, so normalize once here.
          const folderPath = typeof config.folder === 'string' ? config.folder.replace(/\\/gu, '/') : ''
          const folder = folderPath !== '' ? `?folder=${encodeURIComponent(folderPath)}` : ''
          frame.src = `/vscode/${folder}`
        })
        element.appendChild(frame)
        document.body.appendChild(element)
      }

      return {
        /** Start loading the hidden iframe before the panel is first opened. */
        preload() {
          ensure()
        },
        show(next) {
          ensure()
          visible = true
          rect = next
          sync()
        },
        hide() {
          visible = false
          sync()
        },
        setScheme(next) {
          scheme = next === 'light' ? 'light' : 'dark'
          if (frame !== undefined) pushScheme()
        },
        dispose() {
          disposed = true
          visible = false
          element?.remove()
          element = undefined
          frame = undefined
        },
      }
    }

    const surface = createSurface()

    /** The main-slot port: reports its box, never owns the iframe. */
    function VSCodePanel() {
      const host = React.useRef(null)
      React.useEffect(() => {
        const box = host.current
        if (box === null) return undefined
        let frameRequest = 0
        let reportedWidth = -1
        let reportedHeight = -1
        let reportedLeft = -1
        let reportedTop = -1
        const measure = () => {
          if (!box.isConnected) return
          const next = box.getBoundingClientRect()
          if (next.width < 2 || next.height < 2) return
          if (next.width === reportedWidth && next.height === reportedHeight
            && next.left === reportedLeft && next.top === reportedTop) return
          reportedWidth = next.width
          reportedHeight = next.height
          reportedLeft = next.left
          reportedTop = next.top
          surface.show(next)
        }
        const schedule = () => {
          if (frameRequest !== 0) return
          frameRequest = requestAnimationFrame(() => {
            frameRequest = 0
            measure()
          })
        }
        measure()
        const resize = new ResizeObserver(schedule)
        resize.observe(box)
        window.addEventListener('resize', schedule)
        return () => {
          if (frameRequest !== 0) cancelAnimationFrame(frameRequest)
          resize.disconnect()
          window.removeEventListener('resize', schedule)
          surface.hide()
        }
      }, [])
      return h('div', {
        ref: host,
        className: 'dsh-vscode-panel',
        'data-dsh-vscode': 'panel',
        style: { width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' },
      })
    }

    /** Decorative sidebar glyph: a code bracket pair over a terminal prompt. */
    function VSCodeIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', { d: 'M8.5 6.5 3.5 12l5 5.5' }),
      h('path', { d: 'm15.5 6.5 5 5.5-5 5.5' }),
      h('path', { d: 'M13.5 5.5 10.5 18.5' }))
    }

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        const applyTheme = () => {
          const active = ctx.theme.getTheme().active
          surface.setScheme(active?.colorScheme === 'light' ? 'light' : 'dark')
        }
        applyTheme()
        ctx.effect(() => ctx.on('theme/change', applyTheme), 'vscode:theme')
        ctx.effect(() => () => surface.dispose(), 'vscode:surface')
        // The workbench is a multi-megabyte JavaScript payload. Start it while
        // the rest of the UI is idle so the first visit shows the editor
        // instead of code-server's "editor failed to load" startup fallback.
        ctx.effect(() => {
          if (typeof window === 'undefined') return undefined
          if (typeof window.requestIdleCallback === 'function') {
            const id = window.requestIdleCallback(() => surface.preload(), { timeout: 4000 })
            return () => window.cancelIdleCallback(id)
          }
          const id = window.setTimeout(() => surface.preload(), 1500)
          return () => window.clearTimeout(id)
        }, 'vscode:warmup')

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'vscode',
        }, VSCodePanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'vscode',
          order: 30,
          label: () => 'VS Code',
        }, VSCodeIcon))
      },
    }
  },
})
