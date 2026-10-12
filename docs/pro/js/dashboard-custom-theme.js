            // My Skin keys backgrounds by theme id: announce '_custom' (reset: the real id).
            function nbdAnnounceCustomTheme(key) {
              try {
                document.dispatchEvent(new CustomEvent('themechange', { detail: key, bubbles: true, cancelable: false }));
              } catch (e) {}
            }
            function applyCustomTheme() {
              var R = document.documentElement.style;
              var v = function(id) { return document.getElementById(id)?.value || ''; };
              R.setProperty('--orange', v('tbAccent'));
              R.setProperty('--bg', v('tbBg'));
              R.setProperty('--s', v('tbBg')); // sidebar matches bg
              R.setProperty('--s2', v('tbSurface'));
              R.setProperty('--s3', v('tbSurface'));
              R.setProperty('--t', v('tbText'));
              R.setProperty('--m', v('tbMuted'));
              R.setProperty('--br', v('tbBorder'));
              document.body.style.background = v('tbBg');
              // Also update GX accent if active
              if (window.ThemeGX && window.ThemeGX.isEnabled()) {
                window.ThemeGX.setAccent(v('tbAccent'));
              }
              document.documentElement.setAttribute('data-custom-theme', '1');
              nbdAnnounceCustomTheme('_custom');
            }
            function saveCustomTheme() {
              var name = (document.getElementById('tbName')?.value || '').trim() || 'Custom Theme';
              var theme = {
                name: name,
                accent: document.getElementById('tbAccent')?.value,
                bg: document.getElementById('tbBg')?.value,
                surface: document.getElementById('tbSurface')?.value,
                text: document.getElementById('tbText')?.value,
                muted: document.getElementById('tbMuted')?.value,
                border: document.getElementById('tbBorder')?.value
              };
              localStorage.setItem('nbd_custom_theme', JSON.stringify(theme));
              if (typeof showToast === 'function') showToast('Custom theme "' + name + '" saved', 'success');
            }
            function resetCustomTheme() {
              localStorage.removeItem('nbd_custom_theme');
              var R = document.documentElement.style;
              ['--orange','--bg','--s','--s2','--s3','--t','--m','--br'].forEach(function(v) { R.removeProperty(v); });
              document.body.style.background = '';
              document.documentElement.removeAttribute('data-custom-theme');
              // Reset picker values
              document.getElementById('tbAccent').value = '#BD5728';
              document.getElementById('tbBg').value = '#0A0C0F';
              document.getElementById('tbSurface').value = '#181C22';
              document.getElementById('tbText').value = '#E8EAF0';
              document.getElementById('tbMuted').value = '#6B7280';
              document.getElementById('tbBorder').value = '#2a2d35';
              if (typeof showToast === 'function') showToast('Reset to default NBD theme', 'info');
              nbdAnnounceCustomTheme((window.ThemeEngine && window.ThemeEngine.getCurrent && window.ThemeEngine.getCurrent()) || 'nbd-original');
            }
            // Load saved custom theme on boot
            (function() {
              try {
                var saved = JSON.parse(localStorage.getItem('nbd_custom_theme'));
                if (saved && saved.accent) {
                  document.getElementById('tbAccent').value = saved.accent;
                  document.getElementById('tbBg').value = saved.bg || '#0A0C0F';
                  document.getElementById('tbSurface').value = saved.surface || '#181C22';
                  document.getElementById('tbText').value = saved.text || '#E8EAF0';
                  document.getElementById('tbMuted').value = saved.muted || '#6B7280';
                  document.getElementById('tbBorder').value = saved.border || '#2a2d35';
                  document.getElementById('tbName').value = saved.name || '';
                  applyCustomTheme();
                }
              } catch(e) {}
            })();
