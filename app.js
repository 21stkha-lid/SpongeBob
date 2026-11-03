let state = { phone: '', name: '', creditScore: 0, pollInterval: null };

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  event.target.classList.add('active');
  if(tab === 'history') loadHistory();
}

// ====== LOGIN ======
document.getElementById('btn-login').onclick = async () => {
  const name = document.getElementById('input-name').value.trim();
  const phone = document.getElementById('input-phone').value.trim().replace(/\s/g,'');
  if (!name || phone.length < 9) return alert('Please enter valid details');
  state.name = name; state.phone = phone;
  document.getElementById('otp-phone').textContent = phone;

  const btn = document.getElementById('btn-login');
  btn.textContent = 'Sending...'; btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone, name })
    });
    if (!r.ok) throw new Error('Failed');
    showPage('page-otp');
    document.querySelector('.otp-input').focus();
  } catch (e) { alert('Error: ' + e.message); }
  btn.textContent = 'Continue'; btn.disabled = false;
};

// ====== OTP ======
const otpInputs = document.querySelectorAll('.otp-input');
otpInputs.forEach((inp, i) => {
  inp.addEventListener('input', () => { if (inp.value && i < 5) otpInputs[i+1].focus(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && i > 0) otpInputs[i-1].focus(); });
});

document.getElementById('btn-verify').onclick = async () => {
  const otp = Array.from(otpInputs).map(i=>i.value).join('');
  const err = document.getElementById('otp-error');
  err.textContent = '';
  if (otp.length !== 6) { err.textContent = 'Enter all 6 digits'; return; }

  const btn = document.getElementById('btn-verify');
  btn.textContent = 'Verifying...'; btn.disabled = true;
  