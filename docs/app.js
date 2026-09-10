/* llm-session-proxy 文档站交互：复制按钮 + 标签页切换。
   按钮文案通过 data-copied-label / 按钮初始文本提供，中英页面各自传入。 */
(function () {
  'use strict';

  var copiedLabel = document.documentElement.getAttribute('data-copied-label') || '已复制';

  document.querySelectorAll('.copy').forEach(function (button) {
    var idleLabel = button.textContent.trim();
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy') || '';
      var done = function () {
        button.textContent = copiedLabel;
        button.classList.add('done');
        setTimeout(function () {
          button.textContent = idleLabel;
          button.classList.remove('done');
        }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(area);
      }
    });
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (t) {
        t.setAttribute('aria-selected', String(t === tab));
      });
      document.querySelectorAll('.panel').forEach(function (panel) {
        panel.setAttribute('data-active', String(panel.getAttribute('data-panel') === name));
      });
    });
  });
})();
