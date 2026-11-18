import { css } from "lit";
export const runtimeStyles = css`
  :host {
    display: block;
    color: #1d2935;
  }
  section {
    background: white;
    border: 1px solid #dce2e8;
    border-radius: 4px;
    padding: 1rem;
    margin-top: 1rem;
  }
  h2 {
    margin: 0 0 0.65rem;
    font-size: 1rem;
  }
  p {
    margin: 0.5rem 0;
    color: #4d5c68;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  button,
  input,
  textarea {
    box-sizing: border-box;
    font: inherit;
    color: inherit;
    border: 1px solid #a8b7c2;
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    background: white;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .primary {
    background: #356c82;
    color: white;
    border-color: #356c82;
  }
  :is(button, input, textarea, summary):focus-visible {
    outline: 2px solid #356c82;
    outline-offset: 2px;
  }
  form,
  label {
    display: grid;
    gap: 0.4rem;
  }
  form {
    gap: 0.65rem;
    margin-top: 0.6rem;
  }
  textarea,
  input {
    width: 100%;
    min-width: 0;
  }
  textarea,
  code {
    font-family: ui-monospace, Consolas, monospace;
  }
  textarea {
    min-height: 5rem;
    resize: vertical;
  }
  summary {
    cursor: pointer;
    padding: 0.4rem 0;
    font-weight: 600;
  }
  [role="alert"] {
    color: #93451b;
  }
  small {
    color: #4d5c68;
  }
`;
