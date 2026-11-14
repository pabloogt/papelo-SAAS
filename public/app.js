// Mejoras progresivas: todo funciona sin JavaScript.
document.addEventListener('DOMContentLoaded', () => {
  // Confirmación de acciones destructivas.
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Copiar al portapapeles.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = document.querySelector(btn.getAttribute('data-copy'));
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      const old = btn.textContent;
      btn.textContent = '¡Copiado!';
      setTimeout(() => (btn.textContent = old), 1500);
    });
  });

  // Formularios que se envían al cambiar un select (selector de plantilla).
  document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
    form.querySelectorAll('.js-hide').forEach((el) => (el.hidden = true));
    form.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => form.submit()));
  });

  // Portal: mostrar nombre de los archivos elegidos y evitar doble envío.
  document.querySelectorAll('.upload-form').forEach((form) => {
    const input = form.querySelector('input[type=file]');
    const label = form.querySelector('.file-drop span');
    input?.addEventListener('change', () => {
      const n = input.files?.length ?? 0;
      if (label) label.textContent = n === 1 ? input.files[0].name : `${n} archivos seleccionados`;
      form.classList.toggle('has-files', n > 0);
    });
    form.addEventListener('submit', () => {
      const btn = form.querySelector('button[type=submit]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Subiendo…';
      }
    });
  });
});
