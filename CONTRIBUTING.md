# Contribution Guide

Thank you for contributing to EasyEDA AI Assistant!

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating in this project, you agree to abide by its terms.

## How to Contribute

### Reporting Bugs

Before submitting a bug report, please:

1. **Check existing issues** - Make sure the problem has not already been reported
2. **Use the latest version** - Confirm the issue still exists in the latest release
3. **Provide detailed information** - Use the bug report template and include:
   - A clear title and description
   - Steps to reproduce
   - Expected behavior vs actual behavior
   - Environment details (EasyEDA Pro version, operating system, etc.)
   - Debug logs, if applicable
   - Screenshots or screen recordings, if applicable

### Suggesting Features

Feature requests should:

1. **Be specific** - Clearly describe the feature you want
2. **Explain the motivation** - Say why this feature is needed
3. **Provide examples** - If possible, include use cases or examples
4. **Consider alternatives** - Whether there are other ways to achieve the same goal

### Submitting Code

#### Development Workflow

1. **Fork the repository**
   ```bash
   # Fork the repository on GitHub
   git clone https://github.com/YOUR_USERNAME/easyeda-ai-assistant.git
   cd easyeda-ai-assistant
   ```

2. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Make your changes**
   - Follow the code standards (see below)
   - Add necessary tests
   - Update related documentation

5. **Test your changes**
   ```bash
   npm run build
   # Test in EasyEDA Pro
   ```

6. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add amazing feature"
   ```

7. **Push to GitHub**
   ```bash
   git push origin feature/your-feature-name
   ```

8. **Create a Pull Request**
   - Open a PR on GitHub
   - Fill out the PR template
   - Wait for code review

#### Code Standards

**TypeScript Standards**

- Use TypeScript in strict mode
- All functions must have type annotations
- Avoid `any`; prefer specific types
- Use interfaces to define data structures

**Naming Standards**

- Variables/functions: `camelCase`
- Classes/interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Private members: prefix with `_` (for example, `_privateMethod`)

**Code Style**

- Use tab indentation
- Use ESLint auto-formatting: `npm run fix`
- Keep functions under 50 lines where possible, except for complex logic
- Keep each file under 500 lines

**Comment Standards**

```typescript
/**
 * Describes what the function does
 *
 * @param param1 - Description of parameter 1
 * @param param2 - Description of parameter 2
 * @returns Description of the return value
 */
function exampleFunction(param1: string, param2: number): boolean {
    // Implementation logic
    return true;
}
```

#### Commit Message Standards

Use Conventional Commits:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type Values**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation update
- `style`: Code formatting changes (no functional impact)
- `refactor`: Refactoring
- `perf`: Performance improvement
- `test`: Test-related changes
- `chore`: Build or toolchain updates

**Example**

```
feat(collector): add conservative Pin-Net binding strategy

Disable L2/L3/L4 strategies to avoid false positives, and only use L1 netlist binding.
This resolves the issue where NC pins were incorrectly bound to nearby traces.

Closes #123
```

**Required Footer**

Every commit must include:
```
Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

#### Pull Request Standards

**PR Title**

- Use Conventional Commit format
- Keep it concise (`< 70 characters`)

**PR Description**

Must include:

1. **Summary of changes** - Briefly describe what was changed
2. **Motivation and background** - Why this change is needed
3. **Testing plan** - How this change was verified
4. **Screenshots/recordings** - If this is a UI change
5. **Related issue** - Use `Closes #123` if applicable

**PR Checklist**

- [ ] Code follows project standards
- [ ] Necessary comments have been added
- [ ] Related documentation has been updated
- [ ] Tested in EasyEDA Pro
- [ ] Commit messages follow the standard
- [ ] All ESLint warnings have been resolved

### Documentation Contributions

Documentation matters too. You can:

- Fix spelling or grammar mistakes
- Improve the clarity of existing documentation
- Add missing documentation
- Translate documentation into other languages

## Development Environment Setup

### Required Tools

- **Node.js** >= 20.17.0
- **npm** >= 9.0.0
- **EasyEDA Pro** >= 3.0.0
- **Git**

### Recommended Tools

- **VS Code** - Recommended code editor
- **ESLint extension** - Real-time code checking
- **TypeScript extension** - Type checking support

### Project Structure

```
.
|-- src/                   # Source code
|   |-- index.ts           # Extension entry point
|   `-- review/            # AI review module
|       |-- types.ts       # Type definitions
|       |-- config.ts      # Configuration management
|       |-- collector.ts   # Data collection
|       |-- chat-adapter.ts # AI communication
|       `-- orchestrator.ts # Workflow orchestration
|-- iframe/                # Conversation UI
|   `-- chat.html
|-- docs/                  # Documentation
|-- .github/               # GitHub configuration
|-- extension.json         # Extension config
|-- package.json           # Project config
`-- README.md              # Project overview
```

### Debugging Tips

**Enable debug logs**

In EasyEDA Pro:
1. Open the AI assistant panel
2. Click the top-right bug button
3. View detailed collection and binding logs

**Common Issues**

1. **Extension not loading** - Check the `extension.json` format
2. **Build failure** - Run `npm install` to reinstall dependencies
3. **Type errors** - Make sure you are using the latest `@jlceda/pro-api-types`

## Code Review Process

All PRs require code review:

1. **Automated checks** - ESLint, TypeScript compilation
2. **Manual review** - At least one maintainer review
3. **Testing verification** - Test in the real environment
4. **Documentation check** - Make sure documentation is updated

**Review Criteria**

- Code quality and readability
- Whether project standards are followed
- Whether there are sufficient tests
- Whether required documentation exists
- Whether there are potential performance issues
- Whether there are security concerns

## Release Process

(Maintainers only)

1. Update `CHANGELOG.md`
2. Update version numbers (`package.json` and `extension.json`)
3. Create a Git tag: `git tag v1.0.0`
4. Push the tag: `git push origin v1.0.0`
5. GitHub Actions will build and publish automatically

## Getting Help

If you have any questions:

- Read the [documentation](docs/)
- Ask in [Discussions](https://github.com/jifengshandian/easyeda-ai-assistant/discussions)
- Report issues in [Issues](https://github.com/jifengshandian/easyeda-ai-assistant/issues)

## License

By contributing code, you agree that your contributions will be released under the [Apache 2.0 License](LICENSE).

---

Thank you again for your contribution!
