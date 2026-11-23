FROM public.ecr.aws/lambda/python:3.12
RUN dnf install -y cairo pango gdk-pixbuf2 libffi shared-mime-info fontconfig dejavu-sans-fonts dejavu-serif-fonts && dnf clean all
RUN pip install --no-cache-dir weasyprint==70.0 boto3==1.42.0 'Pillow>=11,<13'
COPY memory_export_worker.py ${LAMBDA_TASK_ROOT}/memory_export_worker.py
COPY journal_pages.py ${LAMBDA_TASK_ROOT}/journal_pages.py
COPY memory-book-templates.json ${LAMBDA_TASK_ROOT}/memory-book-templates.json
CMD ["memory_export_worker.handler"]
