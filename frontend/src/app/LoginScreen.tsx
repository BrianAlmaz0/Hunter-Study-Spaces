import { useState, useRef } from 'react';
import { GraduationCap, AlertCircle, CheckCircle, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { API } from './api';

type AuthStep = 'login' | 'signup' | 'verify';
const ALLOWED_DOMAINS = ['login.cuny.edu', 'hunter.cuny.edu', 'myhunter.cuny.edu'];
const isValidCunyEmail = (email: string) =>
  ALLOWED_DOMAINS.some(d => email.toLowerCase().trim().endsWith(`@${d}`));

const inputClass =
  'w-full px-4 py-3 bg-input-background border border-transparent rounded-xl focus:outline-none focus:border-border transition-colors text-base';

function PasswordInput({
  value, onChange, placeholder, show, onToggle, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  show: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const inputRef    = useRef<HTMLInputElement>(null);
  const savedCursor = useRef<{ start: number; end: number } | null>(null);

  const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Prevent focus from leaving the input, and save cursor before anything shifts.
    e.preventDefault();
    if (inputRef.current) {
      savedCursor.current = {
        start: inputRef.current.selectionStart ?? 0,
        end:   inputRef.current.selectionEnd   ?? 0,
      };
    }
  };

  const handleClick = () => {
    onToggle();
    // rAF fires after React's synchronous DOM mutation (type attr change resets selection),
    // but before the browser paints — restore cursor and focus here.
    requestAnimationFrame(() => {
      if (inputRef.current && savedCursor.current !== null) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(
          savedCursor.current.start,
          savedCursor.current.end,
        );
        savedCursor.current = null;
      }
    });
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputClass} pr-12`}
        disabled={disabled}
        required
      />
      <button
        type="button"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        disabled={disabled}
        className="absolute inset-y-0 right-0 flex items-center pr-4 text-muted-foreground hover:text-foreground transition-colors"
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

interface LoginScreenProps {
  onLoginSuccess: (studentData: { name: string; email: string }, token: string) => void;
  isDesktop: boolean;
}

export function LoginScreen({ onLoginSuccess, isDesktop }: LoginScreenProps) {
  const [step, setStep] = useState<AuthStep>('login');
  const [pendingEmail, setPendingEmail] = useState('');

  // Login fields
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Signup fields
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');

  // Verify field
  const [code, setCode] = useState('');

  // Password visibility toggles
  const [showLoginPassword, setShowLoginPassword]     = useState(false);
  const [showSignupPassword, setShowSignupPassword]   = useState(false);
  const [showSignupConfirm, setShowSignupConfirm]     = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(false);

  const clearMessages = () => { setError(null); setInfo(null); };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!isValidCunyEmail(loginEmail)) {
      setError('Use a valid Hunter/CUNY email (@login.cuny.edu, @hunter.cuny.edu, or @myhunter.cuny.edu).');
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const data = await res.json();
      if (res.status === 403 && data.needsVerification) {
        setPendingEmail(data.email);
        setStep('verify');
        setInfo('A new verification code has been sent to your email.');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Login failed.');
      onLoginSuccess(data.student, data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!signupName.trim()) { setError('Please enter your full name.'); return; }
    if (!isValidCunyEmail(signupEmail)) {
      setError('Use a valid Hunter/CUNY email (@login.cuny.edu, @hunter.cuny.edu, or @myhunter.cuny.edu).');
      return;
    }
    if (signupPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (signupPassword !== signupConfirm) { setError('Passwords do not match.'); return; }
    setIsLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: signupName.trim(), email: signupEmail, password: signupPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed.');
      setPendingEmail(data.email);
      setStep('verify');
      setInfo(data.message || 'Check your email for a 6-digit verification code. It expires in 15 minutes.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your email.'); return; }
    setIsLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed.');
      onLoginSuccess(data.student, data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    clearMessages();
    setResendCooldown(true);
    setTimeout(() => setResendCooldown(false), 60_000);
    try {
      const res = await fetch(`${API}/api/auth/resend-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend.');
      setInfo(data.message || 'New code sent! Check your email.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const ErrorBanner = ({ msg }: { msg: string }) => (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl flex items-start gap-2.5"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{msg}</span>
    </motion.div>
  );

  const InfoBanner = ({ msg }: { msg: string }) => (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-xl flex items-start gap-2.5"
    >
      <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{msg}</span>
    </motion.div>
  );

  const subtitle =
    step === 'login' ? 'Sign in to your account' :
    step === 'signup' ? 'Create your account' :
    'Verify your email';

  return (
    <div className="min-h-screen flex items-center justify-center bg-accent/30 px-4">
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className={`bg-card w-full max-w-md rounded-2xl border border-border shadow-xl ${isDesktop ? 'p-8' : 'p-6'}`}
      >
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-6">
          
          <div className="p-4 bg-secondary text-primary rounded-full mb-3">
            <GraduationCap className="w-10 h-10" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Hunter Study Spaces</h1>
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        </div>

        <AnimatePresence mode="wait">

          {/* ── Login ── */}
          {step === 'login' && (
            <motion.form key="login" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.15 }} onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Email</label>
                <input
                  type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
                  placeholder="you@login.cuny.edu" className={inputClass} disabled={isLoading} required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Password</label>
                <PasswordInput
                  value={loginPassword} onChange={setLoginPassword}
                  placeholder="••••••••" show={showLoginPassword}
                  onToggle={() => setShowLoginPassword(v => !v)} disabled={isLoading}
                />
              </div>
              {error && <ErrorBanner msg={error} />}
              
              <button
                type="submit" disabled={isLoading}
                className="w-full py-3.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
              >
                {isLoading ? 'Signing in…' : 'Sign In'}
              </button>
              
              <p className="text-center text-sm text-muted-foreground">
                Don't have an account?{' '}
                <button type="button" onClick={() => { clearMessages(); setStep('signup'); }} className="text-primary hover:underline font-medium">
                  Sign up
                </button>
              </p>
            </motion.form>
          )}

          {/* ── Sign Up ── */}
          {step === 'signup' && (
            <motion.form key="signup" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Full Name</label>
                <input
                  type="text" value={signupName} onChange={e => setSignupName(e.target.value)}
                  placeholder="John Doe" className={inputClass} disabled={isLoading} required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Hunter/CUNY Email</label>
                <input
                  type="email" value={signupEmail} onChange={e => setSignupEmail(e.target.value)}
                  placeholder="you@login.cuny.edu" className={inputClass} disabled={isLoading} required
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Accepts @login.cuny.edu, @hunter.cuny.edu, or @myhunter.cuny.edu
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Password</label>
                <PasswordInput
                  value={signupPassword} onChange={setSignupPassword}
                  placeholder="At least 8 characters" show={showSignupPassword}
                  onToggle={() => setShowSignupPassword(v => !v)} disabled={isLoading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Confirm Password</label>
                <PasswordInput
                  value={signupConfirm} onChange={setSignupConfirm}
                  placeholder="Re-enter password" show={showSignupConfirm}
                  onToggle={() => setShowSignupConfirm(v => !v)} disabled={isLoading}
                />
              </div>
              {error && <ErrorBanner msg={error} />}
              
              <button
                type="submit" disabled={isLoading}
                className="w-full py-3.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
              >
                {isLoading ? 'Creating account…' : 'Create Account'}
              </button>
              
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <button type="button" onClick={() => { clearMessages(); setStep('login'); }} className="text-primary hover:underline font-medium">
                  Sign in
                </button>
              </p>
            </motion.form>
          )}

          {/* ── Verify ── */}
          {step === 'verify' && (
            <motion.form key="verify" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.15 }} onSubmit={handleVerify} className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                We sent a code to <span className="font-medium text-foreground">{pendingEmail}</span>
              </p>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">6-Digit Code</label>
                <input
                  type="text" inputMode="numeric" maxLength={6}
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className={`${inputClass} text-center text-2xl tracking-[0.5em]`}
                  disabled={isLoading} required
                />
              </div>
              {error && <ErrorBanner msg={error} />}
              {info && <InfoBanner msg={info} />}
              
              <button
                type="submit" disabled={isLoading || code.length !== 6}
                className="w-full py-3.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
              >
                {isLoading ? 'Verifying…' : 'Verify Email'}
              </button>
              
              <div className="flex justify-between items-center text-sm">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setCode(''); setStep('signup'); }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  ← Different email
                </button>
                <button
                  type="button" onClick={handleResend} disabled={resendCooldown}
                  className="text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  {resendCooldown ? 'Resent!' : 'Resend code'}
                </button>
              </div>
            </motion.form>
          )}

        </AnimatePresence>
      </motion.div>
    </div>
  );
}
