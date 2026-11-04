// Runs before the stylesheet so a saved theme applies without a flash; dark is the default.
try {
  const theme = localStorage.getItem('taskroom.theme');
  if (theme === 'light' || theme === 'system') document.documentElement.dataset.theme = theme;
} catch { /* Blocked storage only means the default theme. */ }
