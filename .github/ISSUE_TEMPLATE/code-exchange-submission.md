name: Code Exchange Submission
about: Created content or code around Temporal? Tell us about it!
title: "[Submission]: YOUR PROJECT NAME HERE"
labels: code exchange submission
assignees: webchick
body:
  - type: input
    id: link
    attributes:
      label: Link
      description: Project link
      placeholder: ex. https://github.com/myname/foo
    validations:
      required: true
  - type: dropdown
    id: language
    attributes:
      label: Language
      description: What language is your project written in?
      options:
        - (please select)
        - .NET
        - Go
        - Java
        - PHP
        - Python
        - Ruby
        - TypeScript
        - Other / Unofficial SDK
      validations:
        required: true
      default: 0
  - type: textarea
    id: short-description
    attributes:
      label: Short description (max 256 chars)
      description: What's the "elevator pitch" for your project, and why it is useful to Temporal users?
    validations:
      required: true
  - type: textarea
    id: long-description
    attributes:
      label: Long Description
      description: Go into more detail; what's your project about? What types of problems does it solve? Are there screenshots / videos? etc.
    validations:
      required: true
  - type: textarea
    id: author
    attributes:
      label: Author(s)
      description: How author(s) would like to be credited on this submission.
      placeholder: Name / Company / link to picture 
    validations:
      required: true
