import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase/client'

export default function Login() {
  const router = useRouter()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [session, setSession] = useState(null)
  const [checkedSession, setCheckedSession] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setCheckedSession(true)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)

    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setError(error.message)
      } else {
        setMessage('Account created. Check your email to confirm, then sign in.')
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
      } else {
        router.push('/')
      }
    }
    setLoading(false)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  if (!checkedSession) {
    return <div className="container py-5">Loading...</div>
  }

  if (session) {
    return (
      <div className="container py-5">
        <p>Signed in as {session.user.email}</p>
        <button className="btn btn-outline-secondary" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div className="container py-5" style={{ maxWidth: '400px' }}>
      <h1 className="h4 mb-4">{mode === 'signup' ? 'Create account' : 'Sign in'}</h1>
      <form onSubmit={handleSubmit}>
        <div className="mb-3">
          <label className="form-label">Email</label>
          <input
            type="email"
            className="form-control"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="mb-3">
          <label className="form-label">Password</label>
          <input
            type="password"
            className="form-control"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        {message && <div className="alert alert-success py-2">{message}</div>}
        <button type="submit" className="btn btn-primary w-100" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'signup' ? 'Sign up' : 'Sign in'}
        </button>
      </form>
      <button
        type="button"
        className="btn btn-link mt-2"
        onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null); setMessage(null) }}
      >
        {mode === 'signup' ? 'Already have an account? Sign in' : "Need an account? Sign up"}
      </button>
    </div>
  )
}
