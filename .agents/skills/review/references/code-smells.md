# Code Smells

Use this guide during the Standards perspective of a review.
The checklist is based on code smells from Martin Fowler's [Refactoring, second edition](https://martinfowler.com/books/refactoring.html).

## Apply the checklist

- Follow applicable repository guidance first. It takes precedence over this checklist.
- Treat smells as judgment calls, not automatic rule violations. Report them as possible smells and explain the concrete cost or risk.
- Use tooling for mechanical checks instead of repeating its diagnostics as manual findings.
- Use the suggested corrections only when they improve the code. Avoid abstractions added only to satisfy this checklist.

## Smells and possible corrections

- **Mysterious Name:** A name does not explain what a function, variable, or type does or represents. Choose a name that makes its purpose clear.
- **Duplicated Code:** The same logic appears in multiple places. Share the logic when the copies represent the same responsibility and must change together.
- **Feature Envy:** A function depends more on another component's internal data than on its own. Consider moving the operation to the component that owns the data.
- **Data Clumps:** The same group of values repeatedly travels together. Consider a type that gives the group a clear meaning.
- **Primitive Obsession:** A primitive value represents a domain concept whose rules are repeated or left unchecked. Consider a dedicated type that owns those rules.
- **Repeated Switches:** Multiple branches repeat the same decision on a type or value. Consider one shared mapping or behavior owned by the relevant type.
- **Shotgun Surgery:** One logical change requires scattered edits across unrelated components. Consider giving the responsibility one owner.
- **Divergent Change:** One component changes for several unrelated reasons. Consider separating those responsibilities.
- **Speculative Generality:** An abstraction, option, or extension point serves no current requirement. Consider removing it until there is a real need.
- **Message Chains:** A caller navigates through several objects and depends on their internal structure. Consider exposing the complete operation through the owning component.
- **Middle Man:** A layer mostly forwards calls without a useful boundary or responsibility. Consider removing it when direct access preserves the architecture.
- **Refused Bequest:** An implementation rejects or disables behavior promised by its parent or interface. Consider a smaller interface or composition instead of inheritance.
