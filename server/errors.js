// Fehler mit stabilem Code, damit die Oberfläche die Meldung übersetzen kann
export class AppError extends Error {
  constructor(code, message, { status = 502, vars } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.vars = vars;
  }
}
