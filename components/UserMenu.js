import { useEffect, useRef, useState } from 'react'

// Avatar + dropdown that replaced the plain email text and separate "Sign out"
// button in the navbar. UI only — sign-out itself still belongs to the page,
// which passes its existing handler in as onSignOut.
//
// Lives in one component rather than being pasted into both navbars because the
// open/closed state, the outside-click listener and the Escape handler would
// otherwise have to be duplicated into index.js and dashboard.js.

/**
 * First letter to show in the circle.
 *
 * Prefers a real name if Supabase has one in user_metadata (set by OAuth
 * providers, absent for plain email signups), then the email. Anything that
 * isn't a letter or digit — a leading quote, a "+" alias, an empty string — is
 * skipped rather than rendered, and a user with no usable identifier at all
 * falls through to null so the caller can draw a generic icon instead.
 */
function getInitial(user) {
  const candidates = [
    user?.user_metadata?.full_name,
    user?.user_metadata?.name,
    user?.email,
  ]
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const match = value.match(/[a-z0-9]/i)
    if (match) return match[0].toUpperCase()
  }
  return null
}

export default function UserMenu({ session, onSignOut }) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const buttonRef = useRef(null)

  const user = session?.user
  const email = user?.email || ''
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || ''
  const initial = getInitial(user)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  async function handleSignOutClick() {
    setOpen(false)
    await onSignOut?.()
  }

  return (
    <div className="user-menu" ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className="user-menu-avatar"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={email ? `Account menu for ${email}` : 'Account menu'}
        title={email || 'Account'}
      >
        {initial || <span aria-hidden="true">👤</span>}
      </button>

      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-identity">
            {/* Same circle as the navbar button, drawn larger. Decorative here:
             * the name/email below already carry the identity to a reader. */}
            <div className="user-menu-avatar-large" aria-hidden="true">
              {initial || '👤'}
            </div>
            {displayName && <div className="user-menu-name">{displayName}</div>}
            {/* Without a name the email is the only identifying line, so it is
             * promoted out of subtitle styling rather than left as a lone
             * muted string. */}
            <div className={displayName ? 'user-menu-email' : 'user-menu-name'}>
              {email || 'Signed in'}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="btn btn-primary btn-sm w-100 fw-semibold"
            onClick={handleSignOutClick}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
