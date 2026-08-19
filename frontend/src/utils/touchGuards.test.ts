import { describe, it, expect, vi } from 'vitest'
import { installTouchGuards } from './touchGuards'

describe('touchGuards', () => {
  it('installs and uninstalls event listeners correctly', () => {
    const target = new EventTarget()
    const addSpy = vi.spyOn(target, 'addEventListener')
    const removeSpy = vi.spyOn(target, 'removeEventListener')

    const uninstall = installTouchGuards({ target })

    expect(addSpy).toHaveBeenCalledWith('gesturestart', expect.any(Function), { passive: false })
    expect(addSpy).toHaveBeenCalledWith('gesturechange', expect.any(Function), { passive: false })
    expect(addSpy).toHaveBeenCalledWith('gestureend', expect.any(Function), { passive: false })
    expect(addSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), { passive: false })
    expect(addSpy).toHaveBeenCalledWith('dragstart', expect.any(Function), { passive: false })

    uninstall()

    expect(removeSpy).toHaveBeenCalledWith('gesturestart', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('gesturechange', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('gestureend', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('dragstart', expect.any(Function))
  })

  it('prevents default on gesturestart event', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new CustomEvent('gesturestart', { cancelable: true })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })

  it('prevents default on multi-touch touchmove event', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new Event('touchmove', { cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{}, {}],
    })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })

  it('allows single-touch touchmove event (smooth scrolling)', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new Event('touchmove', { cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{}],
    })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).not.toHaveBeenCalled()
  })

  it('prevents default on dragstart event', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new Event('dragstart', { cancelable: true })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })
})
