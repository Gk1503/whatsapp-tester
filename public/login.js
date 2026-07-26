const form = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginResult = document.getElementById('loginResult');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) return;

  loginBtn.disabled = true;
  loginBtn.classList.add('is-loading');
  loginResult.innerHTML = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign in failed');

    window.location.href = '/';
  } catch (err) {
    loginResult.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    loginBtn.disabled = false;
    loginBtn.classList.remove('is-loading');
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
