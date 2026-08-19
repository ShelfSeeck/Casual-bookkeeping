import { describe, it, expect, vi } from 'vitest'
import { installTouchGuards } from './touchGuards'

describe('touchGuards', () => {
  it('installs and uninstalls event listeners correctly on target with capture', () => {
    const target = new EventTarget()
    const addSpy = vi.spyOn(target, 'addEventListener')
    const removeSpy = vi.spyOn(target, 'removeEventListener')

    const uninstall = installTouchGuards({ target })

    const expectedOpts = { passive: false, capture: true }
    expect(addSpy).toHaveBeenCalledWith('gesturestart', expect.any(Function), expectedOpts)
    expect(addSpy).toHaveBeenCalledWith('gesturechange', expect.any(Function), expectedOpts)
    expect(addSpy).toHaveBeenCalledWith('gestureend', expect.any(Function), expectedOpts)
    expect(addSpy).toHaveBeenCalledWith('touchstart', expect.any(Function), expectedOpts)
    expect(addSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), expectedOpts)
    expect(addSpy).toHaveBeenCalledWith('dragstart', expect.any(Function), expectedOpts)

    uninstall()

    const expectedRemoveOpts = { capture: true }
    expect(removeSpy).toHaveBeenCalledWith('gesturestart', expect.any(Function), expectedRemoveOpts)
    expect(removeSpy).toHaveBeenCalledWith('gesturechange', expect.any(Function), expectedRemoveOpts)
    expect(removeSpy).toHaveBeenCalledWith('gestureend', expect.any(Function), expectedRemoveOpts)
    expect(removeSpy).toHaveBeenCalledWith('touchstart', expect.any(Function), expectedRemoveOpts)
    expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), expectedRemoveOpts)
    expect(removeSpy).toHaveBeenCalledWith('dragstart', expect.any(Function), expectedRemoveOpts)
  })

  it('prevents default on gesturestart event', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new CustomEvent('gesturestart', { cancelable: true })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })

  it('prevents default on multi-touch touchstart event (locks initial pinch gesture)', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new Event('touchstart', { cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{}, {}],
    })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })

  it('allows single-touch touchstart event (normal single finger tap)', () => {
    const target = new EventTarget()
    installTouchGuards({ target })

    const event = new Event('touchstart', { cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{}],
    })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    expect(preventSpy).not.toHaveBeenCalled()
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
