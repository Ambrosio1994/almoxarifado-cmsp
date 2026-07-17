export const PASSWORD_POLICY_MESSAGE = "A senha deve ter entre 8 e 256 caracteres, incluindo uma letra maiuscula, um numero e um caractere especial que nao seja espaco.";

export function isValidPasswordInput(password = "") {
  const value = String(password);
  return value.length >= 8
    && value.length <= 256
    && /\p{Lu}/u.test(value)
    && /\p{N}/u.test(value)
    && /[^\p{L}\p{N}\s]/u.test(value);
}

export function enhancePasswordFields(root = document) {
  root.querySelectorAll('input[type="password"]:not([data-password-enhanced])').forEach((input) => {
    input.dataset.passwordEnhanced = "true";
    const wrapper = document.createElement("span");
    wrapper.className = "password-input-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "password-toggle";
    updatePasswordToggle(toggle, false);
    toggle.addEventListener("click", () => {
      const passwordVisible = input.type === "password";
      input.type = passwordVisible ? "text" : "password";
      updatePasswordToggle(toggle, passwordVisible);
    });
    wrapper.append(toggle);
  });
}

export function resetPasswordVisibility(root) {
  root?.querySelectorAll('input[data-password-enhanced]').forEach((input) => {
    input.type = "password";
    const toggle = input.closest(".password-input-wrap")?.querySelector(".password-toggle");
    if (toggle) updatePasswordToggle(toggle, false);
  });
}

function updatePasswordToggle(toggle, passwordVisible) {
  toggle.innerHTML = passwordVisible ? eyeOpenIcon() : eyeOffIcon();
  toggle.setAttribute("aria-label", passwordVisible ? "Ocultar senha" : "Mostrar senha");
  toggle.setAttribute("title", passwordVisible ? "Ocultar senha" : "Mostrar senha");
  toggle.setAttribute("aria-pressed", String(passwordVisible));
}

function eyeOpenIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
      <circle cx="12" cy="12" r="2.75"></circle>
    </svg>
  `;
}

function eyeOffIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 3l18 18"></path>
      <path d="M10.6 6.15A10.2 10.2 0 0 1 12 6c6 0 9.5 6 9.5 6a17.7 17.7 0 0 1-3.05 3.65M6.2 6.2C3.85 7.75 2.5 12 2.5 12s3.5 6 9.5 6a9.9 9.9 0 0 0 3.2-.53"></path>
      <path d="M9.9 9.9a2.75 2.75 0 0 0 4.2 4.2"></path>
    </svg>
  `;
}
